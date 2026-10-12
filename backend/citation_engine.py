from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any


STYLES = {"gb-t-7714-2015-numeric", "apa"}
MAX_INPUT_BYTES = 1800 * 1024
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_PREVIEW_INPUT_BYTES = 120 * 1024
MAX_DOCUMENT_ITEMS = 200
MAX_DOCUMENT_CITATIONS = 500


class CitationEngineError(RuntimeError):
    pass


def _invoke(value: dict[str, Any], style: str) -> dict[str, Any]:
    payload = json.dumps({**value, "style": style}, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(payload.encode("utf-8")) > MAX_INPUT_BYTES:
        raise ValueError("书目字段过大，无法生成引用。")

    root = Path(__file__).resolve().parent.parent
    executable = os.environ.get("WORKBENCH_CITATION_EXECUTABLE") or shutil.which("node")
    script = os.environ.get("WORKBENCH_CITATION_SCRIPT") or str(root / "electron" / "citation-cli.cjs")
    if not executable or not Path(script).is_file():
        raise CitationEngineError("共享引用格式引擎不可用。")

    environment = os.environ.copy()
    if os.environ.get("WORKBENCH_CITATION_EXECUTABLE"):
        environment["ELECTRON_RUN_AS_NODE"] = "1"
    try:
        completed = subprocess.run(
            [executable, script], input=payload, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=15, cwd=str(root), env=environment,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CitationEngineError("共享引用格式引擎运行失败。") from exc
    if completed.returncode != 0 or len(completed.stdout.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise CitationEngineError("共享引用格式引擎无法处理这条书目。")
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise CitationEngineError("共享引用格式引擎返回了无效结果。") from exc
    if not isinstance(result, dict) or result.get("style") != style:
        raise CitationEngineError("共享引用格式引擎返回了不完整结果。")
    if "csl" in value:
        required = {
            "citation_html", "citation_text", "bibliography_html", "bibliography_text",
            "bibliography_body_html", "bibliography_body_text", "fingerprint",
        }
        if not required <= result.keys():
            raise CitationEngineError("共享引用格式引擎返回了不完整结果。")
    return result


def render(csl: dict[str, Any], style: str) -> dict[str, Any]:
    if style not in STYLES:
        raise ValueError("不支持的引用格式。")
    if not isinstance(csl, dict) or not isinstance(csl.get("title"), str):
        raise ValueError("缺少结构化书目信息。")
    if len(json.dumps(csl, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) > MAX_PREVIEW_INPUT_BYTES:
        raise ValueError("单条书目过大，无法生成引用。")
    return _invoke({"csl": csl}, style)


def render_document(state: dict[str, Any], style: str) -> dict[str, Any]:
    if style not in STYLES or not isinstance(state, dict):
        raise ValueError("文档引用状态或格式无效。")
    items = state.get("items")
    citations = state.get("citations")
    if not isinstance(items, dict) or not 1 <= len(items) <= MAX_DOCUMENT_ITEMS:
        raise ValueError("文档引用文献数量超出支持范围。")
    if not isinstance(citations, list) or not 1 <= len(citations) <= MAX_DOCUMENT_CITATIONS:
        raise ValueError("文档中的引用数量超出支持范围。")
    seen: set[str] = set()
    used: set[str] = set()
    cleaned_citations = []
    for raw in citations:
        if not isinstance(raw, dict) or set(raw) - {"id", "items"}:
            raise ValueError("文档引用格式无效。")
        citation_id = raw.get("id")
        cited_items = raw.get("items")
        if not isinstance(citation_id, str) or not 1 <= len(citation_id) <= 128 or citation_id in seen:
            raise ValueError("文档引用标识无效或重复。")
        if not isinstance(cited_items, list) or not 1 <= len(cited_items) <= MAX_DOCUMENT_ITEMS:
            raise ValueError("文档引用项数量无效。")
        seen.add(citation_id)
        cleaned_items = []
        for cited in cited_items:
            if not isinstance(cited, dict) or set(cited) - {"id", "locator", "label"}:
                raise ValueError("文档引用项格式无效。")
            item_id = cited.get("id")
            if not isinstance(item_id, str) or item_id not in items:
                raise ValueError("文档引用指向不存在的书目记录。")
            item = items[item_id]
            if not isinstance(item, dict) or item.get("id") != item_id or not isinstance(item.get("title"), str):
                raise ValueError("文档书目记录格式无效。")
            used.add(item_id)
            normalized = {"id": item_id}
            for field in ("locator", "label"):
                field_value = cited.get(field)
                if field_value is not None:
                    if not isinstance(field_value, str) or len(field_value) > 100:
                        raise ValueError("文档引用定位字段过长。")
                    normalized[field] = field_value
            cleaned_items.append(normalized)
        cleaned_citations.append({"id": citation_id, "items": cleaned_items})
    if used != set(items):
        raise ValueError("文档包含未被引用的书目记录。")
    cleaned_items = {key: value for key, value in items.items()}
    clean_state = {"version": 1, "items": cleaned_items, "citations": cleaned_citations}
    result = _invoke({"state": clean_state}, style)
    if not isinstance(result.get("citations"), dict) or not isinstance(result.get("citation_texts"), dict):
        raise CitationEngineError("共享引用格式引擎未返回文档引用结果。")
    if not isinstance(result.get("bibliography"), dict) or not isinstance(result.get("bibliography", {}).get("entries"), list):
        raise CitationEngineError("共享引用格式引擎未返回书目结果。")
    result["citation_order"] = [entry["id"] for entry in cleaned_citations]
    result["citation_text_order"] = [result["citation_texts"].get(key, "") for key in result["citation_order"]]
    if any(not isinstance(result["citations"].get(key), str) or not isinstance(result["citation_texts"].get(key), str) for key in result["citation_order"]):
        raise CitationEngineError("共享引用格式引擎未返回完整的文中引用。")
    if not isinstance(result.get("bibliography_text"), str):
        raise CitationEngineError("共享引用格式引擎未返回纯文本书目。")
    return result
