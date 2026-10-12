from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
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

from . import bibliography_import, citation_engine
from .db import connect

MAX_PDF_BYTES = 25 * 1024 * 1024
MAX_BODY_BYTES = 36 * 1024 * 1024
MAX_BASE64_CHARS = ((MAX_PDF_BYTES + 2) // 3) * 4
TEXT_FIELDS = ("title", "container_title", "doi", "url", "pdf_url", "volume", "issue", "pages", "publisher", "publisher_place")
PATCH_FIELDS = frozenset((*TEXT_FIELDS, "authors", "year", "item_type", "folder_id", "source_url", "source_citation", "version_label"))
CAPTURE_FIELDS = frozenset((*PATCH_FIELDS, "paper_id", "source", "pdf_content_base64", "pdf_name", "csl"))
MISSING_FIELDS = ("title", "authors", "year", "container_title", "doi", "url")
METADATA_FIELDS = (*TEXT_FIELDS, "authors", "year", "item_type")
ITEM_TYPES = {"journal-article", "paper-conference", "article", "book", "chapter", "report"}
STYLES = citation_engine.STYLES


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
                publisher TEXT NOT NULL DEFAULT '',
                publisher_place TEXT NOT NULL DEFAULT '',
                item_type TEXT NOT NULL DEFAULT 'article',
                folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                source_citation TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                version_label TEXT NOT NULL DEFAULT '',
                field_sources_json TEXT NOT NULL DEFAULT '{}',
                source TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS literature_records_by_doi
                ON literature_records(doi_key) WHERE doi_key <> '';
            CREATE INDEX IF NOT EXISTS literature_records_by_updated
                ON literature_records(updated_at DESC, id);
            CREATE TABLE IF NOT EXISTS literature_citations (
                record_id TEXT NOT NULL REFERENCES literature_records(id) ON DELETE CASCADE,
                style TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                csl_snapshot_json TEXT NOT NULL,
                citation_html TEXT NOT NULL,
                citation_text TEXT NOT NULL,
                bibliography_html TEXT NOT NULL,
                bibliography_text TEXT NOT NULL,
                bibliography_body_html TEXT NOT NULL,
                bibliography_body_text TEXT NOT NULL,
                confirmed_at TEXT NOT NULL,
                PRIMARY KEY(record_id, style)
            );
            """
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(literature_records)").fetchall()}
        for name, definition in (
            ("volume", "TEXT NOT NULL DEFAULT ''"),
            ("issue", "TEXT NOT NULL DEFAULT ''"),
            ("pages", "TEXT NOT NULL DEFAULT ''"),
            ("publisher", "TEXT NOT NULL DEFAULT ''"),
            ("publisher_place", "TEXT NOT NULL DEFAULT ''"),
            ("item_type", "TEXT NOT NULL DEFAULT 'article'"),
            ("folder_id", "TEXT REFERENCES folders(id) ON DELETE SET NULL"),
            ("metadata_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("source_citation", "TEXT NOT NULL DEFAULT ''"),
            ("source_url", "TEXT NOT NULL DEFAULT ''"),
            ("version_label", "TEXT NOT NULL DEFAULT ''"),
            ("field_sources_json", "TEXT NOT NULL DEFAULT '{}'"),
        ):
            if name not in columns:
                db.execute(f"ALTER TABLE literature_records ADD COLUMN {name} {definition}")
        db.execute("DROP INDEX IF EXISTS literature_records_by_paper")
        db.execute("CREATE INDEX IF NOT EXISTS literature_records_by_paper ON literature_records(paper_id) WHERE paper_id IS NOT NULL")
        db.execute("DROP INDEX IF EXISTS literature_records_by_pdf")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS literature_records_by_pdf_version ON literature_records(pdf_key, doi_key) WHERE pdf_key <> ''")
        db.executescript(
            """
            CREATE TRIGGER IF NOT EXISTS literature_sync_paper_folder
            AFTER UPDATE OF folder_id ON papers
            FOR EACH ROW
            BEGIN
                UPDATE literature_records SET folder_id = NEW.folder_id
                WHERE paper_id = NEW.id;
            END;
            """
        )
        db.execute(
            "UPDATE literature_records SET folder_id = (SELECT folder_id FROM papers WHERE papers.id = literature_records.paper_id) "
            "WHERE paper_id IS NOT NULL AND folder_id IS NOT (SELECT folder_id FROM papers WHERE papers.id = literature_records.paper_id)"
        )


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
        fields = {"given", "family", "literal", "dropping-particle", "non-dropping-particle", "suffix", "comma-suffix"}
        if not isinstance(author, dict) or set(author) - fields:
            raise HTTPException(status_code=422, detail="作者字段不符合 CSL 格式。")
        normalized = {
            field: _safe_text(author.get(field, ""), f"author.{field}", 250, optional=True)
            for field in fields if field in author
        }
        if not any(normalized.values()):
            raise HTTPException(status_code=422, detail="作者姓名不能为空。")
        result.append(normalized)
    return result


def _validate_csl(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="csl 需为 CSL-JSON 对象。")
    if "type" in value and not isinstance(value["type"], str):
        raise HTTPException(status_code=422, detail="csl.type 需为文本。")

    def check(item: Any, depth: int = 0) -> None:
        if depth > 12:
            raise HTTPException(status_code=422, detail="csl 嵌套层级过深。")
        if item is None or isinstance(item, (str, bool, int, float)):
            if isinstance(item, float) and (item != item or abs(item) == float("inf")):
                raise HTTPException(status_code=422, detail="csl 中存在无效数字。")
            if isinstance(item, str) and len(item) > 12000:
                raise HTTPException(status_code=422, detail="csl 字段过长。")
            return
        if isinstance(item, list) and len(item) <= 1000:
            for child in item:
                check(child, depth + 1)
            return
        if isinstance(item, dict) and len(item) <= 200:
            for key, child in item.items():
                if not isinstance(key, str) or len(key) > 100 or key.lower() in {"file", "pdf_path", "local_path"}:
                    raise HTTPException(status_code=422, detail="csl 包含不支持的字段。")
                check(child, depth + 1)
            return
        raise HTTPException(status_code=422, detail="csl 结构不符合 CSL-JSON。")

    check(value)
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 110 * 1024:
        raise HTTPException(status_code=422, detail="csl 超过 110 KiB 限制。")
    return dict(value)


def _csl_fields(csl: dict[str, Any]) -> dict[str, Any]:
    item_type = csl.get("type", "")
    type_map = {
        "article-journal": "journal-article", "paper-conference": "paper-conference", "book": "book",
        "chapter": "chapter", "report": "report", "article": "article",
    }
    fields: dict[str, Any] = {}
    for source, target in (
        ("title", "title"), ("container-title", "container_title"), ("DOI", "doi"), ("URL", "url"),
        ("volume", "volume"), ("issue", "issue"), ("page", "pages"), ("publisher", "publisher"),
        ("publisher-place", "publisher_place"),
    ):
        if isinstance(csl.get(source), str):
            fields[target] = csl[source]
    if isinstance(csl.get("author"), list):
        fields["authors"] = csl["author"]
    issued = csl.get("issued")
    date_parts = issued.get("date-parts") if isinstance(issued, dict) else None
    if isinstance(date_parts, list) and date_parts and isinstance(date_parts[0], list) and date_parts[0]:
        fields["year"] = date_parts[0][0]
    elif isinstance(csl.get("year"), (int, str)):
        fields["year"] = csl["year"]
    if item_type in type_map:
        fields["item_type"] = type_map[item_type]
    return fields


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
        payload = response.json()
        message = payload.get("message", {}) if isinstance(payload, dict) else {}
    except (httpx.HTTPError, ValueError, TypeError):
        return {}
    if not isinstance(message, dict):
        return {}

    def text(value: Any, limit: int = 1000) -> str:
        return value[:limit] if isinstance(value, str) else ""

    def first_text(value: Any) -> str:
        if isinstance(value, list):
            return text(value[0]) if value else ""
        return text(value)

    def year_from(value):
        parts = value.get("date-parts") if isinstance(value, dict) else None
        return parts[0][0] if parts and parts[0] and isinstance(parts[0][0], int) else None

    year = year_from(message.get("issued")) or year_from(message.get("published-print")) or year_from(message.get("published-online"))
    authors = []
    raw_authors = message.get("author", [])
    for author in raw_authors if isinstance(raw_authors, list) else []:
        if not isinstance(author, dict):
            continue
        given, family = author.get("given", ""), author.get("family", "")
        if isinstance(given, str) and isinstance(family, str) and (given or family):
            authors.append({"given": given[:250], "family": family[:250]})
    title = first_text(message.get("title", []))
    container = message.get("container-title", [])
    crossref_type = message.get("type", "")
    if not isinstance(crossref_type, str):
        crossref_type = ""
    assertions = message.get("assertion", [])
    conference_chapter = crossref_type == "book-chapter" and any(
        isinstance(assertion, dict) and assertion.get("name") == "conference_name" and assertion.get("value")
        for assertion in (assertions if isinstance(assertions, list) else [])
    )
    if isinstance(container, list) and crossref_type == "book-chapter" and container:
        container = container[-1:]
    metadata = {
        "title": title,
        "authors": authors,
        "year": year if isinstance(year, int) and 1000 <= year <= 9999 else None,
        "container_title": first_text(container),
        "url": text(message.get("URL", ""), 2048),
        "volume": text(message.get("volume", "")),
        "issue": text(message.get("issue", "")),
        "pages": text(message.get("page", "")),
        "publisher": text(message.get("publisher", "")),
        "publisher_place": text(message.get("publisher-location", "")),
        "item_type": "paper-conference" if conference_chapter else {
            "journal-article": "journal-article",
            "proceedings-article": "paper-conference",
            "book": "book",
            "book-chapter": "chapter",
            "report": "report",
        }.get(crossref_type, "article"),
    }
    if not any(metadata.get(field) for field in ("title", "authors", "year", "container_title", "url", "publisher", "publisher_place")):
        return {}
    return metadata


async def _datacite_metadata(doi: str) -> dict[str, Any]:
    key = _doi_key(doi)
    if not re.fullmatch(r"10\.\d{4,9}/[^\s<>\"#?]+", key):
        return {}
    endpoint = "https://api.datacite.org/dois/" + quote(key, safe="/")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(3.0, connect=1.5), follow_redirects=False) as client:
            response = await client.get(endpoint, headers={"Accept": "application/vnd.api+json", "User-Agent": "Folio/1.2 (DOI metadata lookup)"})
        if response.status_code != 200 or response.url.host != "api.datacite.org" or len(response.content) > 1_000_000:
            return {}
        payload = response.json()
        data = payload.get("data", {}) if isinstance(payload, dict) else {}
        attributes = data.get("attributes", {}) if isinstance(data, dict) else {}
    except (httpx.HTTPError, ValueError, TypeError):
        return {}
    if not isinstance(attributes, dict) or not isinstance(attributes.get("creators", []), list) or not isinstance(attributes.get("titles", []), list):
        return {}

    authors = []
    for creator in attributes.get("creators", []):
        if not isinstance(creator, dict):
            continue
        given, family = creator.get("givenName", ""), creator.get("familyName", "")
        name = creator.get("name", "")
        if isinstance(given, str) and isinstance(family, str) and (given or family):
            authors.append({"given": given[:250], "family": family[:250]})
        elif isinstance(name, str) and name:
            authors.append({"literal": name[:250]})
    titles = attributes.get("titles", [])
    title = titles[0].get("title", "") if titles and isinstance(titles[0], dict) else ""
    year = attributes.get("publicationYear")
    if not isinstance(year, int) or not 1000 <= year <= 9999:
        year = None
    raw_types = attributes.get("types", {})
    resource_type = raw_types.get("resourceTypeGeneral", "") if isinstance(raw_types, dict) else ""
    item_type = {"Book": "book", "BookChapter": "chapter", "Report": "report", "ConferencePaper": "paper-conference"}.get(resource_type, "article")
    return {
        "title": title[:1000] if isinstance(title, str) else "", "authors": authors, "year": year,
        "container_title": (attributes.get("container", {}).get("title", "")[:1000] if isinstance(attributes.get("container"), dict) and isinstance(attributes.get("container", {}).get("title", ""), str) else ""),
        "url": attributes.get("url", "")[:2048] if isinstance(attributes.get("url", ""), str) else "",
        "volume": "", "issue": "", "pages": "", "publisher": attributes.get("publisher", "")[:1000] if isinstance(attributes.get("publisher", ""), str) else "",
        "publisher_place": "", "item_type": item_type,
    }


async def _lookup_doi(doi: str) -> dict[str, Any]:
    key = _doi_key(doi)
    if not re.fullmatch(r"10\.\d{4,9}/[^\s<>\"#?]+", key):
        raise HTTPException(status_code=422, detail="DOI 格式无效。")
    metadata = await _crossref_metadata(key)
    source = "crossref"
    source_url = "https://api.crossref.org/works/" + quote(key, safe="/")
    if not metadata:
        metadata = await _datacite_metadata(key)
        source = "datacite"
        source_url = "https://api.datacite.org/dois/" + quote(key, safe="/")
    if not metadata:
        raise HTTPException(status_code=404, detail="未能从 Crossref 或 DataCite 找到这条 DOI 记录。")
    item_type = metadata.get("item_type", "article")
    csl_type = "article-journal" if item_type == "journal-article" else item_type
    csl: dict[str, Any] = {
        "id": "preview", "type": csl_type, "title": metadata.get("title", ""), "author": metadata.get("authors", []),
        "container-title": metadata.get("container_title", ""), "DOI": key, "URL": metadata.get("url", ""),
    }
    if metadata.get("year"):
        csl["issued"] = {"date-parts": [[metadata["year"]]]}
    for field, csl_field in (("volume", "volume"), ("issue", "issue"), ("pages", "page"), ("publisher", "publisher"), ("publisher_place", "publisher-place")):
        if metadata.get(field):
            csl[csl_field] = metadata[field]
    return {"doi": key, "source": source, "source_url": source_url, "metadata": metadata, "record": csl}


async def _enrich_missing_from_crossref(values: dict[str, Any]) -> set[str]:
    doi = values.get("doi", "")
    if values.get("source") == "local_pdf" or not doi:
        return set()
    if all(values.get(field) for field in ("title", "authors", "year", "container_title", "url", "volume", "issue", "pages", "publisher", "publisher_place")):
        return set()
    metadata = await _crossref_metadata(doi)
    filled = set()
    for field in ("title", "authors", "year", "container_title", "url", "volume", "issue", "pages", "publisher", "publisher_place"):
        if not values.get(field) and metadata.get(field):
            values[field] = metadata[field]
            filled.add(field)
    if "item_type" not in values and metadata.get("item_type"):
        values["item_type"] = metadata["item_type"]
        filled.add("item_type")
    return filled


def _csl(record: dict[str, Any]) -> dict[str, Any]:
    try:
        csl = json.loads(record.get("metadata_json", "{}") or "{}")
    except (AttributeError, TypeError, json.JSONDecodeError):
        csl = {}
    if not isinstance(csl, dict):
        csl = {}
    sources = record.get("field_sources", {}) or {}
    saved_type = csl.get("type")
    internal_type = {
        "article-journal": "journal-article", "paper-conference": "paper-conference",
        "book": "book", "chapter": "chapter", "report": "report",
    }.get(saved_type, "article")
    csl_type = saved_type if saved_type and internal_type == record["item_type"] and sources.get("item_type") != "user" else (
        "article-journal" if record["item_type"] == "journal-article" else record["item_type"]
    )
    csl.update({
        "id": record["id"], "type": csl_type, "title": record["title"], "author": record["authors"],
        "container-title": record["container_title"], "DOI": record["doi"], "URL": record["url"],
    })
    if record["year"] is not None:
        issued = csl.get("issued")
        parts = issued.get("date-parts") if isinstance(issued, dict) else None
        if not (isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0] and parts[0][0] == record["year"]):
            csl["issued"] = {"date-parts": [[record["year"]]]}
    elif sources.get("year") == "user":
        csl.pop("issued", None)
    for field in ("volume", "issue", "pages", "publisher", "publisher_place"):
        csl_field = {"pages": "page", "publisher_place": "publisher-place"}.get(field, field)
        if record[field]:
            csl[csl_field] = record[field]
        elif sources.get(field) == "user":
            csl.pop(csl_field, None)
    return csl


def _record(row: sqlite3.Row | dict[str, Any], citation_rows: list[sqlite3.Row] | None = None) -> dict[str, Any]:
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
        "publisher": row["publisher"],
        "publisher_place": row["publisher_place"],
        "item_type": row["item_type"],
        "metadata_json": row["metadata_json"],
        "folder_id": row["effective_folder_id"] if "effective_folder_id" in row.keys() else row["folder_id"],
        "source_citation": row["source_citation"],
        "source_url": row["source_url"],
        "version_label": row["version_label"],
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
    item.pop("metadata_json", None)
    if citation_rows is None:
        with connect() as db:
            citation_rows = db.execute("SELECT * FROM literature_citations WHERE record_id = ?", (item["id"],)).fetchall()
    current_snapshot = json.dumps(item["csl"], ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    citations = {style: {"confirmed": False, "stale": False} for style in STYLES}
    for saved in citation_rows:
        try:
            saved_snapshot = json.dumps(json.loads(saved["csl_snapshot_json"]), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        except (TypeError, json.JSONDecodeError):
            saved_snapshot = ""
        citations[saved["style"]] = {
            "confirmed": True,
            "stale": saved_snapshot != current_snapshot,
            "fingerprint": saved["fingerprint"],
            "citation_html": saved["citation_html"],
            "citation_text": saved["citation_text"],
            "bibliography_html": saved["bibliography_html"],
            "bibliography_text": saved["bibliography_text"],
            "bibliography_body_html": saved["bibliography_body_html"],
            "bibliography_body_text": saved["bibliography_body_text"],
            "confirmed_at": saved["confirmed_at"],
        }
    item["citations"] = citations
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


def _validate_extras(value: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if "folder_id" in value:
        folder_id = value["folder_id"]
        if folder_id is not None:
            folder_id = _safe_text(folder_id, "folder_id", 64)
            with connect() as db:
                if not db.execute("SELECT 1 FROM folders WHERE id = ?", (folder_id,)).fetchone():
                    raise HTTPException(status_code=404, detail="找不到所选文件夹。")
        result["folder_id"] = folder_id
    for field, limit in (("source_url", 2048), ("source_citation", 120 * 1024), ("version_label", 200)):
        if field in value:
            text = _safe_text(value[field], field, limit, optional=True)
            result[field] = _safe_url(text, field) if field == "source_url" else text
    return result


def _metadata_from_csl(value: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    csl = _validate_csl(value)
    fields = _validate_fields(_csl_fields(csl), PATCH_FIELDS)
    return fields, csl


def _get_record(record_id: str):
    with connect() as db:
        row = db.execute(
            "SELECT literature_records.*, CASE WHEN papers.id IS NOT NULL THEN papers.folder_id ELSE literature_records.folder_id END AS effective_folder_id "
            "FROM literature_records LEFT JOIN papers ON papers.id = literature_records.paper_id WHERE literature_records.id = ?",
            (record_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="找不到这条书目记录。")
    return row


def _keys(values: dict[str, Any]) -> tuple[str, str]:
    return _doi_key(values.get("doi", "")), _pdf_key(values.get("pdf_url", ""))


def _find_duplicate(db, doi_key: str, pdf_key: str):
    by_doi = db.execute("SELECT * FROM literature_records WHERE doi_key = ?", (doi_key,)).fetchone() if doi_key else None
    if by_doi:
        return by_doi
    if pdf_key:
        return db.execute(
            "SELECT * FROM literature_records WHERE pdf_key = ? AND doi_key = ''", (pdf_key,),
        ).fetchone()
    return None


def _empty(field: str, value: Any) -> bool:
    return value is None or value == "" or (field == "authors" and value == [])


def _merge_missing(record_id: str, incoming: dict[str, Any]) -> None:
    row = _get_record(record_id)
    current = _record(row)
    sources = dict(current["field_sources"])
    incoming_sources = incoming.get("field_sources", {})
    changes: dict[str, Any] = {}
    selected_fields = incoming.get("_supplement_fields", METADATA_FIELDS)
    for field in METADATA_FIELDS:
        if field not in selected_fields:
            continue
        value = incoming.get(field)
        if field in incoming and not _empty(field, current.get(field)) and not (field == "item_type" and current.get(field) == "article"):
            continue
        if field not in incoming or sources.get(field) == "user" or _empty(field, value):
            continue
        changes[field] = value
        sources[field] = incoming_sources.get(field, incoming.get("source", ""))
    extras: dict[str, str] = {}
    for field in ("source_citation", "source_url", "version_label"):
        value = incoming.get(field, "")
        if value and not current.get(field):
            extras[field] = value
    metadata = dict(current["csl"])
    metadata_changed = False
    incoming_csl = incoming.get("csl", {})
    field_for_csl = {
        "title": "title", "author": "authors", "issued": "year", "container-title": "container_title",
        "DOI": "doi", "URL": "url", "volume": "volume", "issue": "issue", "page": "pages",
        "publisher": "publisher", "publisher-place": "publisher_place",
    }
    if isinstance(incoming_csl, dict):
        for key, value in incoming_csl.items():
            field = field_for_csl.get(key)
            if key == "id" or (field and sources.get(field) == "user"):
                continue
            current_value = metadata.get(key)
            if current_value is not None and current_value != "" and current_value != []:
                continue
            if value is not None and value != "" and value != []:
                metadata[key] = value
                metadata_changed = True
    if not changes and not extras and not metadata_changed:
        return
    merged = {**current, **changes}
    doi_key, pdf_key = _keys(merged)
    metadata.update(_csl({**merged, "field_sources": sources, "metadata_json": metadata}))
    metadata_json = json.dumps(metadata, ensure_ascii=False, allow_nan=False)
    with connect() as db:
        assignments = []
        params: list[Any] = []
        columns = {
            "title": "title", "container_title": "container_title", "doi": "doi", "url": "url",
            "pdf_url": "pdf_url", "volume": "volume", "issue": "issue", "pages": "pages", "year": "year", "item_type": "item_type",
            "publisher": "publisher", "publisher_place": "publisher_place",
        }
        for field, column in columns.items():
            if field in changes:
                assignments.append(f"{column} = ?")
                params.append(changes[field])
        if "authors" in changes:
            assignments.append("authors_json = ?")
            params.append(json.dumps(changes["authors"], ensure_ascii=False))
        assignments.extend(("doi_key = ?", "pdf_key = ?", "metadata_json = ?", "field_sources_json = ?"))
        params.extend((doi_key, pdf_key, metadata_json, json.dumps(sources, ensure_ascii=False)))
        for field, value in extras.items():
            assignments.append(f"{field} = ?")
            params.append(value)
        assignments.append("updated_at = ?")
        params.extend((_now(), record_id))
        db.execute(f"UPDATE literature_records SET {', '.join(assignments)} WHERE id = ?", params)


def _create_record(values: dict[str, Any], paper_id: str | None) -> tuple[str, bool]:
    record_id = uuid.uuid4().hex
    doi_key, pdf_key = _keys(values)
    timestamp = _now()
    existing_id = None
    duplicate = False
    with connect() as db:
        by_key = _find_duplicate(db, doi_key, pdf_key)
        existing = by_key
        if not existing and not doi_key and not pdf_key and paper_id:
            existing = db.execute(
                "SELECT * FROM literature_records WHERE paper_id = ? AND doi_key = '' AND pdf_key = '' ORDER BY created_at, id LIMIT 1",
                (paper_id,),
            ).fetchone()
        if existing:
            if paper_id and existing["paper_id"] and existing["paper_id"] != paper_id:
                raise HTTPException(status_code=409, detail="这条书目已关联到另一篇本地 PDF。")
            if paper_id and not existing["paper_id"]:
                db.execute("UPDATE literature_records SET paper_id = ?, updated_at = ? WHERE id = ?", (paper_id, timestamp, existing["id"]))
            existing_id = existing["id"]
            duplicate = True
        else:
            sources = values.get("field_sources", {})
            metadata = dict(values.get("csl", {}))
            metadata["id"] = record_id
            metadata_json = json.dumps(metadata, ensure_ascii=False, allow_nan=False)
            try:
                db.execute(
                    "INSERT INTO literature_records(id, paper_id, folder_id, title, authors_json, year, container_title, doi, doi_key, url, pdf_url, pdf_key, volume, issue, pages, publisher, publisher_place, item_type, metadata_json, source_citation, source_url, version_label, field_sources_json, source, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        record_id, paper_id, values.get("folder_id"), values.get("title", ""), json.dumps(values.get("authors", []), ensure_ascii=False),
                        values.get("year"), values.get("container_title", ""), values.get("doi", ""), doi_key,
                        values.get("url", ""), values.get("pdf_url", ""), pdf_key, values.get("volume", ""),
                        values.get("issue", ""), values.get("pages", ""), values.get("publisher", ""), values.get("publisher_place", ""), values.get("item_type", "article"),
                        metadata_json, values.get("source_citation", ""), values.get("source_url", ""), values.get("version_label", ""),
                        json.dumps(sources, ensure_ascii=False), values.get("source", ""), timestamp, timestamp,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise HTTPException(status_code=409, detail="书目记录已存在或关联冲突。") from exc
    if existing_id:
        _merge_missing(existing_id, values)
    return existing_id or record_id, duplicate


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


def _citation_rows(db, record_ids: list[str]) -> dict[str, list[sqlite3.Row]]:
    result: dict[str, list[sqlite3.Row]] = {record_id: [] for record_id in record_ids}
    for start in range(0, len(record_ids), 500):
        batch = record_ids[start:start + 500]
        marks = ",".join("?" for _ in batch)
        for row in db.execute(f"SELECT * FROM literature_citations WHERE record_id IN ({marks})", batch):
            result[row["record_id"]].append(row)
    return result


def _snapshot_json(csl: dict[str, Any]) -> str:
    return json.dumps(csl, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _supplement_fingerprint(lookup: dict[str, Any]) -> str:
    canonical = json.dumps(
        {"doi": lookup["doi"], "source": lookup["source"], "metadata": lookup["metadata"]},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _supplement_changes(record: dict[str, Any], metadata: dict[str, Any]) -> dict[str, dict[str, Any]]:
    changes = {}
    for field in METADATA_FIELDS:
        incoming = metadata.get(field)
        if _empty(field, incoming) or incoming == record.get(field):
            continue
        manual = record["field_sources"].get(field) == "user"
        changes[field] = {
            "current": record.get(field), "incoming": incoming,
            "manual": manual, "fillable": (_empty(field, record.get(field)) or (field == "item_type" and record.get(field) == "article")) and not manual,
        }
    return changes


def _missing_csl_fields(csl: dict[str, Any]) -> list[str]:
    issued = csl.get("issued")
    parts = issued.get("date-parts") if isinstance(issued, dict) else None
    has_year = isinstance(parts, list) and bool(parts) and isinstance(parts[0], list) and bool(parts[0])
    return [
        field for field, present in (
            ("title", bool(csl.get("title"))), ("authors", bool(csl.get("author"))), ("year", has_year),
            ("container_title", bool(csl.get("container-title"))), ("doi", bool(csl.get("DOI"))), ("url", bool(csl.get("URL"))),
        ) if not present
    ]


def register(app, authorize: Callable[..., Any], import_pdf: Callable[[str, str | None], dict[str, Any]]) -> None:
    """Mount Folio bibliographic routes without opening the database at import time."""

    @app.get("/literature", dependencies=[Depends(authorize)])
    def list_literature(q: str = "", folder_id: str = "all", confirmed_style: str = ""):
        ensure_tables()
        if len(q) > 300:
            raise HTTPException(status_code=422, detail="搜索内容不能超过 300 个字符。")
        if folder_id not in {"all", "unfiled"}:
            with connect() as db:
                if not db.execute("SELECT 1 FROM folders WHERE id = ?", (folder_id,)).fetchone():
                    raise HTTPException(status_code=404, detail="找不到所选文件夹。")
        if confirmed_style and confirmed_style not in STYLES:
            raise HTTPException(status_code=422, detail="不支持的引用格式。")
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        conditions = ["(? = '' OR r.title LIKE ? ESCAPE '\\' OR r.doi LIKE ? ESCAPE '\\' OR r.container_title LIKE ? ESCAPE '\\' OR r.authors_json LIKE ? ESCAPE '\\' OR r.metadata_json LIKE ? ESCAPE '\\' OR r.source_citation LIKE ? ESCAPE '\\')"]
        parameters: list[Any] = [q, pattern, pattern, pattern, pattern, pattern, pattern]
        effective_folder = "CASE WHEN p.id IS NOT NULL THEN p.folder_id ELSE r.folder_id END"
        if folder_id == "unfiled":
            conditions.append(f"{effective_folder} IS NULL")
        elif folder_id != "all":
            conditions.append(f"{effective_folder} = ?")
            parameters.append(folder_id)
        query = (
            "SELECT r.*, " + effective_folder + " AS effective_folder_id "
            "FROM literature_records r LEFT JOIN papers p ON p.id = r.paper_id WHERE "
            + " AND ".join(conditions) + " ORDER BY r.updated_at DESC, r.id"
        )
        with connect() as db:
            rows = db.execute(query, parameters).fetchall()
            citation_map = _citation_rows(db, [row["id"] for row in rows])
        items = [_record(row, citation_map[row["id"]]) for row in rows]
        if confirmed_style:
            items = [item for item in items if item["citations"][confirmed_style]["confirmed"] and not item["citations"][confirmed_style]["stale"]]
        return {"items": items, "total": len(items)}

    @app.get("/literature/{record_id}", dependencies=[Depends(authorize)])
    def get_literature(record_id: str):
        ensure_tables()
        return _record(_get_record(record_id))

    @app.delete("/literature/{record_id}", dependencies=[Depends(authorize)])
    def delete_literature(record_id: str):
        ensure_tables()
        with connect() as db:
            cursor = db.execute("DELETE FROM literature_records WHERE id = ?", (record_id,))
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="找不到这条书目。")
        return {"deleted": True}

    @app.patch("/literature/{record_id}", dependencies=[Depends(authorize)])
    async def patch_literature(record_id: str, request: Request):
        ensure_tables()
        raw = await _request_json(request)
        changes = _validate_fields(raw, PATCH_FIELDS)
        changes.update(_validate_extras(raw))
        if not changes:
            raise HTTPException(status_code=422, detail="请提供至少一个要修改的字段。")
        row = _get_record(record_id)
        merged = _record(row)
        merged.update(changes)
        field_sources = dict(merged["field_sources"])
        for field in changes.keys() & METADATA_FIELDS:
            field_sources[field] = "user"
        metadata = _csl({**merged, "metadata_json": merged["csl"], "field_sources": field_sources})
        doi_key, pdf_key = _keys(merged)
        try:
            with connect() as db:
                conflict = _find_duplicate(db, doi_key, pdf_key)
                if conflict and conflict["id"] != record_id:
                    raise HTTPException(status_code=409, detail="DOI 或 PDF 链接已存在于另一条书目记录。")
                db.execute(
                    "UPDATE literature_records SET folder_id = ?, title = ?, authors_json = ?, year = ?, container_title = ?, doi = ?, doi_key = ?, url = ?, pdf_url = ?, pdf_key = ?, volume = ?, issue = ?, pages = ?, publisher = ?, publisher_place = ?, item_type = ?, metadata_json = ?, source_citation = ?, source_url = ?, version_label = ?, field_sources_json = ?, updated_at = ? WHERE id = ?",
                    (
                        merged["folder_id"], merged["title"], json.dumps(merged["authors"], ensure_ascii=False), merged["year"], merged["container_title"],
                        merged["doi"], doi_key, merged["url"], merged["pdf_url"], pdf_key, merged["volume"], merged["issue"], merged["pages"],
                        merged["publisher"], merged["publisher_place"], merged["item_type"], json.dumps(metadata, ensure_ascii=False, allow_nan=False),
                        merged["source_citation"], merged["source_url"], merged["version_label"], json.dumps(field_sources, ensure_ascii=False), _now(), record_id,
                    ),
                )
                if "folder_id" in changes and merged["paper_id"]:
                    db.execute("UPDATE papers SET folder_id = ?, updated_at = ? WHERE id = ?", (merged["folder_id"], _now(), merged["paper_id"]))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="DOI 或 PDF 链接已存在于另一条书目记录。") from exc
        return _record(_get_record(record_id))

    @app.post("/literature/preview", dependencies=[Depends(authorize)])
    async def preview_citation(request: Request):
        ensure_tables()
        raw = await _request_json(request)
        if set(raw) != {"record", "style"} or raw.get("style") not in STYLES:
            raise HTTPException(status_code=422, detail="请提供 CSL-JSON 记录和受支持的引用格式。")
        csl = _validate_csl(raw["record"])
        if not isinstance(csl.get("title"), str):
            raise HTTPException(status_code=422, detail="书目题名需为文本。")
        try:
            return await run_in_threadpool(citation_engine.render, csl, raw["style"])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except citation_engine.CitationEngineError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/literature/{record_id}/citations", dependencies=[Depends(authorize)])
    async def confirm_citation(record_id: str, request: Request):
        ensure_tables()
        raw = await _request_json(request)
        if set(raw) != {"style", "fingerprint"} or raw.get("style") not in STYLES:
            raise HTTPException(status_code=422, detail="请提供受支持的引用格式和预览指纹。")
        fingerprint = raw.get("fingerprint")
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise HTTPException(status_code=422, detail="引用预览指纹格式无效。")
        item = _record(_get_record(record_id))
        try:
            rendered = await run_in_threadpool(citation_engine.render, item["csl"], raw["style"])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except citation_engine.CitationEngineError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        if not hmac.compare_digest(rendered["fingerprint"], fingerprint):
            raise HTTPException(status_code=409, detail="书目信息已变化，请重新预览后确认。")
        with connect() as db:
            db.execute(
                "INSERT INTO literature_citations(record_id, style, fingerprint, csl_snapshot_json, citation_html, citation_text, bibliography_html, bibliography_text, bibliography_body_html, bibliography_body_text, confirmed_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(record_id, style) DO UPDATE SET fingerprint = excluded.fingerprint, csl_snapshot_json = excluded.csl_snapshot_json, citation_html = excluded.citation_html, citation_text = excluded.citation_text, bibliography_html = excluded.bibliography_html, bibliography_text = excluded.bibliography_text, bibliography_body_html = excluded.bibliography_body_html, bibliography_body_text = excluded.bibliography_body_text, confirmed_at = excluded.confirmed_at",
                (
                    record_id, raw["style"], rendered["fingerprint"], _snapshot_json(item["csl"]), rendered["citation_html"], rendered["citation_text"],
                    rendered["bibliography_html"], rendered["bibliography_text"], rendered["bibliography_body_html"], rendered["bibliography_body_text"], _now(),
                ),
            )
        return _record(_get_record(record_id))

    @app.post("/literature/render-document", dependencies=[Depends(authorize)])
    async def render_document(request: Request):
        ensure_tables()
        raw = await _request_json(request)
        if set(raw) != {"state", "style"} or raw.get("style") not in STYLES or not isinstance(raw.get("state"), dict):
            raise HTTPException(status_code=422, detail="请提供文档引用状态和受支持的格式。")
        state = raw["state"]
        if set(state) - {"version", "style", "items", "citations", "bibliographyText"} or state.get("version") not in {None, 1}:
            raise HTTPException(status_code=422, detail="文档引用状态版本或字段无效。")
        items = state.get("items")
        if not isinstance(items, dict) or not 1 <= len(items) <= citation_engine.MAX_DOCUMENT_ITEMS:
            raise HTTPException(status_code=422, detail="文档引用书目数量超出支持范围。")
        for item_id, item in list(items.items()):
            if not isinstance(item_id, str) or not 1 <= len(item_id) <= 128 or not isinstance(item, dict) or item.get("id") != item_id:
                raise HTTPException(status_code=422, detail="文档书目记录标识或结构无效。")
            normalized = _validate_csl(item)
            normalized.setdefault("title", "")
            if not isinstance(normalized.get("title"), str):
                raise HTTPException(status_code=422, detail="文档书目题名格式无效。")
            items[item_id] = normalized
        if state.get("style") not in {None, raw["style"]}:
            raise HTTPException(status_code=422, detail="文档和请求中的引用格式不一致。")
        try:
            if len(json.dumps(state, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")) > 900 * 1024:
                raise HTTPException(status_code=413, detail="文档引用状态超过桥接消息大小限制。")
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="文档引用状态不是有效 JSON。") from exc
        try:
            result = await run_in_threadpool(citation_engine.render_document, state, raw["style"])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except citation_engine.CitationEngineError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        result["incomplete_items"] = [
            {"id": item_id, "missing_fields": _missing_csl_fields(item)}
            for item_id, item in state["items"].items() if _missing_csl_fields(item)
        ]
        if len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 900 * 1024:
            raise HTTPException(status_code=413, detail="文档引用结果超过桥接消息大小限制。")
        return result

    @app.post("/literature/parse", dependencies=[Depends(authorize)])
    async def parse_literature(request: Request):
        raw = await _request_json(request)
        if set(raw) != {"format", "data"}:
            raise HTTPException(status_code=422, detail="请提供导入格式和书目内容。")
        try:
            items = bibliography_import.parse_import(raw["format"], raw["data"])
            return {"items": [
                {"record": _validate_csl(item["record"]), "source_citation": _safe_text(item["source_citation"], "source_citation", 120 * 1024)}
                for item in items
            ]}
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @app.post("/literature/resolve", dependencies=[Depends(authorize)])
    async def resolve_doi(request: Request):
        raw = await _request_json(request)
        if set(raw) != {"doi"} or not isinstance(raw.get("doi"), str):
            raise HTTPException(status_code=422, detail="请提供 DOI。")
        lookup = await _lookup_doi(raw["doi"])
        return {"doi": lookup["doi"], "source": lookup["source"], "source_url": lookup["source_url"], "record": lookup["record"]}

    @app.post("/literature/{record_id}/supplement/preview", dependencies=[Depends(authorize)])
    async def preview_supplement(record_id: str):
        ensure_tables()
        current = _record(_get_record(record_id))
        if not current["doi"]:
            raise HTTPException(status_code=422, detail="请先为书目记录填写 DOI。")
        lookup = await _lookup_doi(current["doi"])
        return {
            "source": lookup["source"], "source_url": lookup["source_url"],
            "source_fingerprint": _supplement_fingerprint(lookup),
            "changes": _supplement_changes(current, lookup["metadata"]),
        }

    @app.post("/literature/{record_id}/supplement/apply", dependencies=[Depends(authorize)])
    async def apply_supplement(record_id: str, request: Request):
        ensure_tables()
        raw = await _request_json(request)
        if set(raw) != {"source_fingerprint", "fields"}:
            raise HTTPException(status_code=422, detail="请提供已预览的来源指纹和字段列表。")
        fingerprint, fields = raw.get("source_fingerprint"), raw.get("fields")
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise HTTPException(status_code=422, detail="来源指纹格式无效。")
        if not isinstance(fields, list) or len(fields) > len(METADATA_FIELDS) or any(not isinstance(field, str) or field not in METADATA_FIELDS for field in fields) or len(set(fields)) != len(fields):
            raise HTTPException(status_code=422, detail="所选补充字段无效。")
        current = _record(_get_record(record_id))
        if not current["doi"]:
            raise HTTPException(status_code=422, detail="请先为书目记录填写 DOI。")
        lookup = await _lookup_doi(current["doi"])
        if not hmac.compare_digest(_supplement_fingerprint(lookup), fingerprint):
            raise HTTPException(status_code=409, detail="来源元数据已变化，请重新查看差异后再补充。")
        incoming = _validate_fields(lookup["metadata"], frozenset(METADATA_FIELDS))
        incoming["field_sources"] = {field: lookup["source"] for field in fields}
        incoming["source"] = lookup["source"]
        incoming["source_url"] = lookup["source_url"]
        incoming["_supplement_fields"] = fields
        before = {field: current.get(field) for field in fields}
        _merge_missing(record_id, incoming)
        saved = _record(_get_record(record_id))
        applied = [field for field in fields if before.get(field) != saved.get(field) and saved["field_sources"].get(field) == lookup["source"]]
        return {"item": saved, "applied": applied, "skipped": [field for field in fields if field not in applied]}

    @app.post("/literature/capture", dependencies=[Depends(authorize)])
    async def capture_literature(request: Request):
        ensure_tables()
        raw = await _request_json(request)
        unknown = set(raw) - CAPTURE_FIELDS
        if unknown:
            raise HTTPException(status_code=422, detail=f"不支持的字段：{', '.join(sorted(unknown))}。")
        values = _validate_fields(raw, CAPTURE_FIELDS)
        csl_metadata = {}
        if "csl" in raw:
            csl_fields, csl_metadata = _metadata_from_csl(raw["csl"])
            values = {**csl_fields, **values}
        values.update(_validate_extras(raw))
        values["csl"] = csl_metadata
        paper_id = raw.get("paper_id")
        paper = None
        if paper_id is not None:
            paper_id = _safe_text(paper_id, "paper_id", 64)
            with connect() as db:
                paper = db.execute("SELECT english_title, chinese_title, folder_id FROM papers WHERE id = ?", (paper_id,)).fetchone()
            if not paper:
                raise HTTPException(status_code=404, detail="找不到要关联的本地 PDF。")
            if not values.get("title"):
                values["title"] = paper["english_title"] or paper["chinese_title"] or ""
            if "folder_id" not in raw:
                values["folder_id"] = paper["folder_id"]
        folder_id = values.get("folder_id")
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
            if enriched and not values.get("source_url"):
                values["source_url"] = "https://api.crossref.org/works/" + quote(_doi_key(values.get("doi", "")), safe="/")
        if "item_type" not in values:
            values["item_type"] = "article" if values["source"] == "local_pdf" or not values.get("container_title") else "journal-article"
            field_sources["item_type"] = values["source"]
        values["field_sources"] = field_sources
        record_id, duplicate_record = _create_record(values, paper_id)
        if "folder_id" in raw:
            with connect() as db:
                if paper_id:
                    db.execute("UPDATE papers SET folder_id = ?, updated_at = ? WHERE id = ?", (folder_id, _now(), paper_id))
                    db.execute("UPDATE literature_records SET folder_id = ? WHERE paper_id = ?", (folder_id, paper_id))
                else:
                    db.execute("UPDATE literature_records SET folder_id = ?, updated_at = ? WHERE id = ?", (folder_id, _now(), record_id))

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
                    current_paper = db.execute("SELECT paper_id FROM literature_records WHERE id = ?", (record_id,)).fetchone()["paper_id"]
                    if current_paper and current_paper != imported_id:
                        raise PDFAssociationConflict("这条书目已关联另一份 PDF；请先在 Folio 中处理现有关联。")
                    if folder_id is not None:
                        db.execute("UPDATE papers SET folder_id = ?, updated_at = ? WHERE id = ?", (folder_id, _now(), imported_id))
                        db.execute("UPDATE literature_records SET folder_id = ? WHERE paper_id = ?", (folder_id, imported_id))
                    db.execute(
                        "UPDATE literature_records SET paper_id = ?, folder_id = COALESCE(?, folder_id), updated_at = ? WHERE id = ?",
                        (imported_id, folder_id, _now(), record_id),
                    )
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
