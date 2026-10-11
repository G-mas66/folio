from __future__ import annotations

import base64
import binascii
import hashlib
import ipaddress
import json
import os
import re
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urlsplit, urlunsplit

import httpx
from fastapi import Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from .db import connect

MAX_PDF_BYTES = 25 * 1024 * 1024
MAX_BODY_BYTES = 36 * 1024 * 1024
MAX_BASE64_CHARS = ((MAX_PDF_BYTES + 2) // 3) * 4
TEXT_FIELDS = ("title", "container_title", "doi", "url", "pdf_url", "volume", "issue", "pages")
PATCH_FIELDS = frozenset((*TEXT_FIELDS, "authors", "year", "item_type"))
CAPTURE_FIELDS = frozenset((*PATCH_FIELDS, "paper_id", "folder_id", "source", "pdf_content_base64", "pdf_name"))
MISSING_FIELDS = ("title", "authors", "year", "container_title", "doi", "url")
METADATA_FIELDS = (*TEXT_FIELDS, "authors", "year", "item_type")
ITEM_TYPES = {"journal-article", "paper-conference", "article", "book", "report"}


class PDFAssociationConflict(ValueError):
    pass


def ensure_tables() -> None:
    """Create Folio's independent bibliography table after the core DB is ready."""
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS literature_records (
                id TEXT PRIMARY KEY,
                paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
                title TEXT NOT NULL DEFAULT '',
                authors_json TEXT NOT NULL DEFAULT '[]',
                year INTEGER,
                container_title TEXT NOT NULL DEFAULT '',
                doi TEXT NOT NULL DEFAULT '',
                doi_key TEXT NOT NULL DEFAULT '',
                url TEXT NOT NULL DEFAULT '',
                pdf_url TEXT NOT NULL DEFAULT '',
                pdf_key TEXT NOT NULL DEFAULT '',
                volume TEXT NOT NULL DEFAULT '',
                issue TEXT NOT NULL DEFAULT '',
                pages TEXT NOT NULL DEFAULT '',
                item_type TEXT NOT NULL DEFAULT 'article',
                field_sources_json TEXT NOT NULL DEFAULT '{}',
                source TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS literature_records_by_doi
                ON literature_records(doi_key) WHERE doi_key <> '';
            CREATE UNIQUE INDEX IF NOT EXISTS literature_records_by_pdf
                ON literature_records(pdf_key) WHERE pdf_key <> '';
            CREATE INDEX IF NOT EXISTS literature_records_by_updated
                ON literature_records(updated_at DESC, id);
            """
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(literature_records)").fetchall()}
        for name, definition in (
            ("volume", "TEXT NOT NULL DEFAULT ''"),
            ("issue", "TEXT NOT NULL DEFAULT ''"),
            ("pages", "TEXT NOT NULL DEFAULT ''"),
            ("item_type", "TEXT NOT NULL DEFAULT 'article'"),
            ("field_sources_json", "TEXT NOT NULL DEFAULT '{}'"),
        ):
            if name not in columns:
                db.execute(f"ALTER TABLE literature_records ADD COLUMN {name} {definition}")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS literature_records_by_paper ON literature_records(paper_id) WHERE paper_id IS NOT NULL")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_text(value: Any, field: str, limit: int, *, optional: bool = False) -> str:
    if value is None and optional:
        return ""
    if not isinstance(value, str) or len(value) > limit or "\x00" in value:
        raise HTTPException(status_code=422, detail=f"{field} 格式不正确。")
    return value


def _authors(value: Any) -> list[dict[str, str]]:
    if value is None or value == "":
        return []
    if not isinstance(value, list) or len(value) > 100:
        raise HTTPException(status_code=422, detail="authors 需为不超过 100 项的 CSL 作者列表。")
    result: list[dict[str, str]] = []
    for author in value:
        if not isinstance(author, dict) or set(author) - {"given", "family"}:
            raise HTTPException(status_code=422, detail="作者需包含 given 和 family 字段。")
        result.append({
            "given": _safe_text(author.get("given", ""), "author.given", 250, optional=True),
            "family": _safe_text(author.get("family", ""), "author.family", 250, optional=True),
        })
    return result


def _year(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise HTTPException(status_code=422, detail="year 需为 1000 到 9999 之间的年份。")
    if isinstance(value, str) and re.fullmatch(r"\d{4}", value):
        value = int(value)
    if not isinstance(value, int) or not 1000 <= value <= 9999:
        raise HTTPException(status_code=422, detail="year 需为 1000 到 9999 之间的年份。")
    return value


def _item_type(value: Any) -> str:
    if value is None or value == "":
        return "article"
    if value not in ITEM_TYPES:
        raise HTTPException(status_code=422, detail="item_type 不受支持。")
    return value


def _safe_url(value: str, field: str) -> str:
    if not value:
        return value
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field} 需为安全的 HTTP(S) 链接。") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not host or parsed.username or parsed.password:
        raise HTTPException(status_code=422, detail=f"{field} 需为安全的 HTTP(S) 链接。")
    hostname = host.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal", ".lan")):
        raise HTTPException(status_code=422, detail=f"{field} 不能指向本地网络地址。")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and not address.is_global:
        raise HTTPException(status_code=422, detail=f"{field} 不能指向本地网络地址。")
    return value


def _doi_key(value: str) -> str:
    normalized = value.strip()
    normalized = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", normalized, flags=re.IGNORECASE)
    return normalized.rstrip(".,; ").casefold()


def _pdf_key(value: str) -> str:
    if not value:
        return ""
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme.lower(), (parsed.netloc or "").lower(), parsed.path, parsed.query, ""))


async def _crossref_metadata(doi: str) -> dict[str, Any]:
    key = _doi_key(doi)
    if not re.fullmatch(r"10\.\d{4,9}/[^\s<>\"#?]+", key):
        return {}
    endpoint = "https://api.crossref.org/works/" + quote(key, safe="/")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=1.5), follow_redirects=False) as client:
            response = await client.get(endpoint, headers={"Accept": "application/json", "User-Agent": "Folio/1.2 (DOI metadata lookup)"})
        if response.status_code != 200 or response.url.host != "api.crossref.org" or len(response.content) > 1_000_000:
            return {}
        message = response.json().get("message", {})
    except (httpx.HTTPError, ValueError, TypeError):
        return {}

    def year_from(value):
        parts = value.get("date-parts") if isinstance(value, dict) else None
        return parts[0][0] if parts and parts[0] and isinstance(parts[0][0], int) else None

    year = year_from(message.get("issued")) or year_from(message.get("published-print")) or year_from(message.get("published-online"))
    authors = []
    for author in message.get("author", []):
        if not isinstance(author, dict):
            continue
        given, family = author.get("given", ""), author.get("family", "")
        if isinstance(given, str) and isinstance(family, str) and (given or family):
            authors.append({"given": given[:250], "family": family[:250]})
    title = message.get("title", [""])
    container = message.get("container-title", [""])
    crossref_type = message.get("type", "")
    return {
        "title": title[0][:1000] if title and isinstance(title[0], str) else "",
        "authors": authors,
        "year": year if isinstance(year, int) and 1000 <= year <= 9999 else None,
        "container_title": container[0][:1000] if container and isinstance(container[0], str) else "",
        "url": message.get("URL", "") if isinstance(message.get("URL", ""), str) else "",
        "volume": message.get("volume", "") if isinstance(message.get("volume", ""), str) else "",
        "issue": message.get("issue", "") if isinstance(message.get("issue", ""), str) else "",
        "pages": message.get("page", "") if isinstance(message.get("page", ""), str) else "",
        "item_type": {
            "journal-article": "journal-article",
            "proceedings-article": "paper-conference",
            "book": "book",
            "report": "report",
        }.get(crossref_type, "article"),
    }


async def _enrich_missing_from_crossref(values: dict[str, Any]) -> set[str]:
    doi = values.get("doi", "")
    if values.get("source") == "local_pdf" or not doi:
        return set()
    if all(values.get(field) for field in ("title", "authors", "year", "container_title", "url", "volume", "issue", "pages")):
        return set()
    metadata = await _crossref_metadata(doi)
    filled = set()
    for field in ("title", "authors", "year", "container_title", "url", "volume", "issue", "pages"):
        if not values.get(field) and metadata.get(field):
            values[field] = metadata[field]
            filled.add(field)
    if "item_type" not in values and metadata.get("item_type"):
        values["item_type"] = metadata["item_type"]
        filled.add("item_type")
    return filled


def _csl(record: dict[str, Any]) -> dict[str, Any]:
    csl_type = "article-journal" if record["item_type"] == "journal-article" else record["item_type"]
    csl: dict[str, Any] = {
        "id": record["id"],
        "type": csl_type,
        "title": record["title"],
        "author": record["authors"],
        "container-title": record["container_title"],
        "DOI": record["doi"],
        "URL": record["url"],
    }
    if record["year"] is not None:
        csl["issued"] = {"date-parts": [[record["year"]]]}
    for field in ("volume", "issue", "pages"):
        if record[field]:
            csl["page" if field == "pages" else field] = record[field]
    return csl


def _record(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    authors = json.loads(row["authors_json"] or "[]")
    try:
        field_sources = json.loads(row["field_sources_json"] or "{}")
    except (KeyError, TypeError, json.JSONDecodeError):
        field_sources = {}
    item = {
        "id": row["id"],
        "paper_id": row["paper_id"],
        "title": row["title"],
        "authors": authors,
        "year": row["year"],
        "container_title": row["container_title"],
        "doi": row["doi"],
        "url": row["url"],
        "pdf_url": row["pdf_url"],
        "volume": row["volume"],
        "issue": row["issue"],
        "pages": row["pages"],
        "item_type": row["item_type"],
        "field_sources": field_sources,
        "source": row["source"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    item["missing_fields"] = [
        field for field in MISSING_FIELDS
        if (not item[field] if field in {"title", "container_title", "doi", "url"} else not item[field])
    ]
    item["csl"] = _csl(item)
    return item


async def _request_json(request: Request) -> dict[str, Any]:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        raise HTTPException(status_code=415, detail="请求需使用 application/json。")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="请求超过 36 MiB 限制。")
        body.extend(chunk)
    try:
        value = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="请求 JSON 无效。") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="请求需为 JSON 对象。")
    return value


def _validate_fields(value: dict[str, Any], fields: set[str] | frozenset[str]) -> dict[str, Any]:
    unknown = set(value) - fields
    if unknown:
        raise HTTPException(status_code=422, detail=f"不支持的字段：{', '.join(sorted(unknown))}。")
    result: dict[str, Any] = {}
    for field in TEXT_FIELDS:
        if field in value:
            text = _safe_text(value[field], field, 2048 if field in {"url", "pdf_url"} else 1000, optional=True)
            result[field] = _safe_url(text, field) if field in {"url", "pdf_url"} else text
    if "authors" in value:
        result["authors"] = _authors(value["authors"])
    if "year" in value:
        result["year"] = _year(value["year"])
    if "item_type" in value:
        result["item_type"] = _item_type(value["item_type"])
    return result


def _get_record(record_id: str):
    with connect() as db:
        row = db.execute("SELECT * FROM literature_records WHERE id = ?", (record_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="找不到这条书目记录。")
    return row


def _keys(values: dict[str, Any]) -> tuple[str, str]:
    return _doi_key(values.get("doi", "")), _pdf_key(values.get("pdf_url", ""))


def _find_duplicate(db, doi_key: str, pdf_key: str):
    matches = []
    if doi_key:
        row = db.execute("SELECT * FROM literature_records WHERE doi_key = ?", (doi_key,)).fetchone()
        if row:
            matches.append(row)
    if pdf_key:
        row = db.execute("SELECT * FROM literature_records WHERE pdf_key = ?", (pdf_key,)).fetchone()
        if row:
            matches.append(row)
    if len({row["id"] for row in matches}) > 1:
        raise HTTPException(status_code=409, detail="DOI 与 PDF 链接分别对应不同书目记录。")
    return matches[0] if matches else None


def _find_by_paper(db, paper_id: str | None):
    return db.execute("SELECT * FROM literature_records WHERE paper_id = ?", (paper_id,)).fetchone() if paper_id else None


def _empty(field: str, value: Any) -> bool:
    return value is None or value == "" or (field == "authors" and value == [])


def _merge_missing(record_id: str, incoming: dict[str, Any]) -> None:
    row = _get_record(record_id)
    current = _record(row)
    sources = dict(current["field_sources"])
    incoming_sources = incoming.get("field_sources", {})
    changes: dict[str, Any] = {}
    for field in METADATA_FIELDS:
        value = incoming.get(field)
        if field in incoming and not _empty(field, current.get(field)) and not (field == "item_type" and current.get(field) == "article"):
            continue
        if field not in incoming or sources.get(field) == "user" or _empty(field, value):
            continue
        changes[field] = value
        sources[field] = incoming_sources.get(field, incoming.get("source", ""))
    if not changes:
        return
    merged = {**current, **changes}
    doi_key, pdf_key = _keys(merged)
    with connect() as db:
        conflict = _find_duplicate(db, doi_key, pdf_key)
        if conflict and conflict["id"] != record_id:
            if "doi" in changes:
                changes.pop("doi")
                doi_key = _doi_key(current["doi"])
            if "pdf_url" in changes:
                changes.pop("pdf_url")
                pdf_key = _pdf_key(current["pdf_url"])
        assignments = []
        params: list[Any] = []
        columns = {
            "title": "title", "container_title": "container_title", "doi": "doi", "url": "url",
            "pdf_url": "pdf_url", "volume": "volume", "issue": "issue", "pages": "pages", "year": "year", "item_type": "item_type",
        }
        for field, column in columns.items():
            if field in changes:
                assignments.append(f"{column} = ?")
                params.append(changes[field])
        if "authors" in changes:
            assignments.append("authors_json = ?")
            params.append(json.dumps(changes["authors"], ensure_ascii=False))
        assignments.extend(("doi_key = ?", "pdf_key = ?", "field_sources_json = ?", "updated_at = ?"))
        params.extend((doi_key, pdf_key, json.dumps(sources, ensure_ascii=False), _now(), record_id))
        db.execute(f"UPDATE literature_records SET {', '.join(assignments)} WHERE id = ?", params)


def _create_record(values: dict[str, Any], paper_id: str | None) -> tuple[str, bool, bool]:
    record_id = uuid.uuid4().hex
    doi_key, pdf_key = _keys(values)
    timestamp = _now()
    existing_id = None
    duplicate = False
    with connect() as db:
        by_paper = _find_by_paper(db, paper_id)
        by_key = _find_duplicate(db, doi_key, pdf_key)
        if by_paper and by_key and by_paper["id"] != by_key["id"]:
            raise HTTPException(status_code=409, detail="本地 PDF 与 DOI/PDF 链接对应不同书目记录。")
        existing = by_paper or by_key
        if existing:
            if paper_id and existing["paper_id"] and existing["paper_id"] != paper_id:
                raise HTTPException(status_code=409, detail="这条书目已关联到另一篇本地 PDF。")
            if paper_id and not existing["paper_id"]:
                db.execute("UPDATE literature_records SET paper_id = ?, updated_at = ? WHERE id = ?", (paper_id, timestamp, existing["id"]))
            existing_id = existing["id"]
            duplicate = True
        else:
            sources = values.get("field_sources", {})
            try:
                db.execute(
                    "INSERT INTO literature_records(id, paper_id, title, authors_json, year, container_title, doi, doi_key, url, pdf_url, pdf_key, volume, issue, pages, item_type, field_sources_json, source, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        record_id, paper_id, values.get("title", ""), json.dumps(values.get("authors", []), ensure_ascii=False),
                        values.get("year"), values.get("container_title", ""), values.get("doi", ""), doi_key,
                        values.get("url", ""), values.get("pdf_url", ""), pdf_key, values.get("volume", ""),
                        values.get("issue", ""), values.get("pages", ""), values.get("item_type", "article"),
                        json.dumps(sources, ensure_ascii=False), values.get("source", ""), timestamp, timestamp,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise HTTPException(status_code=409, detail="书目记录已存在或关联冲突。") from exc
    if existing_id:
        _merge_missing(existing_id, values)
        return existing_id, duplicate, False
    return record_id, duplicate, True


def _merge_records(primary_id: str, secondary_id: str, paper_id: str) -> None:
    if primary_id == secondary_id:
        with connect() as db:
            db.execute("UPDATE literature_records SET paper_id = COALESCE(paper_id, ?), updated_at = ? WHERE id = ?", (paper_id, _now(), primary_id))
        return
    primary = _record(_get_record(primary_id))
    secondary = _record(_get_record(secondary_id))
    sources = dict(primary["field_sources"])
    changes: dict[str, Any] = {}
    for field in METADATA_FIELDS:
        if not _empty(field, primary.get(field)) or sources.get(field) == "user" or _empty(field, secondary.get(field)):
            continue
        changes[field] = secondary[field]
        sources[field] = secondary["field_sources"].get(field, secondary["source"])
    merged = {**primary, **changes}
    doi_key, pdf_key = _keys(merged)
    with connect() as db:
        conflict = _find_duplicate(db, doi_key, pdf_key)
        if conflict and conflict["id"] not in {primary_id, secondary_id}:
            if "doi" in changes:
                changes.pop("doi")
                doi_key = _doi_key(primary["doi"])
            if "pdf_url" in changes:
                changes.pop("pdf_url")
                pdf_key = _pdf_key(primary["pdf_url"])
        db.execute("DELETE FROM literature_records WHERE id = ?", (secondary_id,))
        merged = {**primary, **changes}
        assignments = []
        params: list[Any] = []
        columns = {
            "title": "title", "container_title": "container_title", "doi": "doi", "url": "url", "pdf_url": "pdf_url",
            "volume": "volume", "issue": "issue", "pages": "pages", "year": "year", "item_type": "item_type",
        }
        for field, column in columns.items():
            if field in changes:
                assignments.append(f"{column} = ?")
                params.append(changes[field])
        if "authors" in changes:
            assignments.append("authors_json = ?")
            params.append(json.dumps(changes["authors"], ensure_ascii=False))
        assignments.extend(("paper_id = COALESCE(paper_id, ?)", "doi_key = ?", "pdf_key = ?", "field_sources_json = ?", "updated_at = ?"))
        params.extend((paper_id, doi_key, pdf_key, json.dumps(sources, ensure_ascii=False), _now(), primary_id))
        db.execute(f"UPDATE literature_records SET {', '.join(assignments)} WHERE id = ?", params)


def _safe_pdf_name(value: str) -> str:
    name = Path(value.replace("\\", "/")).name.strip()
    name = re.sub(r"[\x00-\x1f<>:\"/\\|?*]", "_", name).strip(" .")
    if not name:
        name = "captured-paper.pdf"
    if not name.lower().endswith(".pdf"):
        name += ".pdf"
    return name[:180]


def _decode_pdf(value: str) -> bytes:
    if len(value) > MAX_BASE64_CHARS:
        raise ValueError("PDF 超过 25 MiB 限制。")
    try:
        content = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("PDF 数据编码无效。") from exc
    if not content:
        raise ValueError("PDF 文件为空。")
    if len(content) > MAX_PDF_BYTES:
        raise ValueError("PDF 超过 25 MiB 限制。")
    if b"%PDF-" not in content[:1024]:
        raise ValueError("上传内容不是有效 PDF。")
    return content


def _write_temp_pdf(content: bytes, name: str) -> tuple[str, str]:
    directory = tempfile.mkdtemp(prefix="folio-literature-")
    path = Path(directory) / _safe_pdf_name(name)
    path.write_bytes(content)
    return directory, str(path)


def register(app, authorize: Callable[..., Any], import_pdf: Callable[[str, str | None], dict[str, Any]]) -> None:
    """Mount Folio bibliographic routes without opening the database at import time."""

    @app.get("/literature", dependencies=[Depends(authorize)])
    def list_literature(q: str = ""):
        ensure_tables()
        if len(q) > 300:
            raise HTTPException(status_code=422, detail="搜索内容不能超过 300 个字符。")
        with connect() as db:
            rows = db.execute(
                "SELECT * FROM literature_records WHERE ? = '' OR title LIKE ? ESCAPE '\\' OR doi LIKE ? ESCAPE '\\' "
                "OR container_title LIKE ? ESCAPE '\\' OR authors_json LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id",
                (q, f"%{q.replace('%', r'\%').replace('_', r'\_')}%", f"%{q.replace('%', r'\%').replace('_', r'\_')}%", f"%{q.replace('%', r'\%').replace('_', r'\_')}%", f"%{q.replace('%', r'\%').replace('_', r'\_')}%"),
            ).fetchall()
        items = [_record(row) for row in rows]
        return {"items": items, "total": len(items)}

    @app.get("/literature/{record_id}", dependencies=[Depends(authorize)])
    def get_literature(record_id: str):
        ensure_tables()
        return _record(_get_record(record_id))

    @app.patch("/literature/{record_id}", dependencies=[Depends(authorize)])
    async def patch_literature(record_id: str, request: Request):
        ensure_tables()
        changes = _validate_fields(await _request_json(request), PATCH_FIELDS)
        if not changes:
            raise HTTPException(status_code=422, detail="请提供至少一个要修改的字段。")
        row = _get_record(record_id)
        merged = _record(row)
        merged.update(changes)
        field_sources = dict(merged["field_sources"])
        for field in changes:
            field_sources[field] = "user"
        doi_key, pdf_key = _keys(merged)
        try:
            with connect() as db:
                conflict = _find_duplicate(db, doi_key, pdf_key)
                if conflict and conflict["id"] != record_id:
                    raise HTTPException(status_code=409, detail="DOI 或 PDF 链接已存在于另一条书目记录。")
                db.execute(
                    "UPDATE literature_records SET title = ?, authors_json = ?, year = ?, container_title = ?, doi = ?, doi_key = ?, url = ?, pdf_url = ?, pdf_key = ?, volume = ?, issue = ?, pages = ?, item_type = ?, field_sources_json = ?, updated_at = ? WHERE id = ?",
                    (
                        merged["title"], json.dumps(merged["authors"], ensure_ascii=False), merged["year"], merged["container_title"],
                        merged["doi"], doi_key, merged["url"], merged["pdf_url"], pdf_key, merged["volume"], merged["issue"], merged["pages"],
                        merged["item_type"], json.dumps(field_sources, ensure_ascii=False), _now(), record_id,
                    ),
                )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="DOI 或 PDF 链接已存在于另一条书目记录。") from exc
        return _record(_get_record(record_id))

    @app.post("/literature/capture", dependencies=[Depends(authorize)])
    async def capture_literature(request: Request):
        ensure_tables()
        raw = await _request_json(request)
        unknown = set(raw) - CAPTURE_FIELDS
        if unknown:
            raise HTTPException(status_code=422, detail=f"不支持的字段：{', '.join(sorted(unknown))}。")
        values = _validate_fields(raw, CAPTURE_FIELDS)
        paper_id = raw.get("paper_id")
        if paper_id is not None:
            paper_id = _safe_text(paper_id, "paper_id", 64)
            with connect() as db:
                paper = db.execute("SELECT english_title, chinese_title FROM papers WHERE id = ?", (paper_id,)).fetchone()
            if not paper:
                raise HTTPException(status_code=404, detail="找不到要关联的本地 PDF。")
            if "title" not in raw:
                values["title"] = paper["english_title"] or paper["chinese_title"] or ""
        folder_id = raw.get("folder_id")
        if folder_id is not None:
            folder_id = _safe_text(folder_id, "folder_id", 64)
        values["source"] = _safe_text(raw.get("source", "browser"), "source", 100, optional=True)
        field_sources = {
            field: values["source"] for field in METADATA_FIELDS
            if field in values and not _empty(field, values[field])
        }
        doi_key, pdf_key = _keys(values)
        with connect() as db:
            duplicate = _find_duplicate(db, doi_key, pdf_key)
        if not duplicate:
            enriched = await _enrich_missing_from_crossref(values)
            for field in enriched:
                field_sources[field] = "crossref"
        if "item_type" not in values:
            values["item_type"] = "article" if values["source"] == "local_pdf" or not values.get("container_title") else "journal-article"
            field_sources["item_type"] = values["source"]
        values["field_sources"] = field_sources
        record_id, duplicate_record, created_record = _create_record(values, paper_id)

        pdf_data = raw.get("pdf_content_base64")
        if pdf_data is None:
            return {"item": _record(_get_record(record_id)), "duplicate_record": duplicate_record, "pdf_import": {"status": "not_requested", "error": ""}}
        if not isinstance(pdf_data, str):
            reason = "PDF 数据格式无效。"
            return JSONResponse(
                status_code=207,
                content={"item": _record(_get_record(record_id)), "duplicate_record": duplicate_record, "pdf_import": {"status": "failed", "error": reason}},
            )

        directory = None
        temporary_pdf = None
        try:
            content = _decode_pdf(pdf_data)
            directory, temporary_pdf = _write_temp_pdf(content, _safe_text(raw.get("pdf_name", "captured-paper.pdf"), "pdf_name", 300, optional=True))
            if folder_id:
                with connect() as db:
                    folder = db.execute("SELECT 1 FROM folders WHERE id = ?", (folder_id,)).fetchone()
                if not folder:
                    raise ValueError("所选文件夹已不存在，书目已保存，请重新选择文件夹后导入 PDF。")
            digest = hashlib.sha256(content).hexdigest()
            with connect() as db:
                matching_paper = db.execute("SELECT id FROM papers WHERE source_hash = ?", (digest,)).fetchone()
                current_paper = db.execute("SELECT paper_id FROM literature_records WHERE id = ?", (record_id,)).fetchone()["paper_id"]
            if current_paper and (not matching_paper or matching_paper["id"] != current_paper):
                raise PDFAssociationConflict("这条书目已关联另一份 PDF；为避免错误合并，请先在 Folio 中处理现有关联。")
            imported = await run_in_threadpool(import_pdf, temporary_pdf, folder_id)
            imported_paper = imported.get("paper") or {}
            imported_id = imported_paper.get("id")
            if imported_id:
                with connect() as db:
                    related = db.execute("SELECT id FROM literature_records WHERE paper_id = ?", (imported_id,)).fetchone()
                if related and related["id"] != record_id:
                    if not created_record:
                        raise PDFAssociationConflict("此 PDF 已关联到另一条已存在书目。为保留 CSL 引用的稳定 ID，书目未合并；请在 Folio 中处理关联。")
                    _merge_records(related["id"], record_id, imported_id)
                    record_id = related["id"]
                    duplicate_record = True
                else:
                    with connect() as db:
                        db.execute("UPDATE literature_records SET paper_id = COALESCE(paper_id, ?), updated_at = ? WHERE id = ?", (imported_id, _now(), record_id))
            else:
                raise ValueError("PDF 导入没有返回本地文献记录。")
            status = "duplicate" if imported.get("duplicate") else "imported"
            pdf_result = {"status": status, "error": "", "paper_id": imported_id, "duplicate": bool(imported.get("duplicate"))}
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, str) else "PDF 导入失败，请稍后重试。"
            pdf_result = {"status": "failed", "error": detail}
        except PDFAssociationConflict as exc:
            pdf_result = {"status": "conflict", "error": str(exc)}
        except (ValueError, OSError) as exc:
            pdf_result = {"status": "failed", "error": str(exc)}
        except Exception:
            pdf_result = {"status": "failed", "error": "PDF 导入失败，请稍后重试。"}
        finally:
            if temporary_pdf:
                try:
                    os.unlink(temporary_pdf)
                except OSError:
                    pass
            if directory:
                try:
                    os.rmdir(directory)
                except OSError:
                    pass

        payload = {"item": _record(_get_record(record_id)), "duplicate_record": duplicate_record, "pdf_import": pdf_result}
        return JSONResponse(status_code=207 if pdf_result["status"] in {"failed", "conflict"} else 200, content=payload)
