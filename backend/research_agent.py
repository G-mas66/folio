from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from . import ai
from .db import connect

MAX_MODEL_CALLS = 14
MAX_TOOL_CALLS = 24
MAX_INPUT_CHARS = 100_000
MAX_IMAGE_BYTES = 2_000_000
MAX_TOTAL_IMAGE_BYTES = 8_000_000
MAX_IMAGE_COUNT = 6
MAX_TASK_SECONDS = 1_200
MAX_IMAGE_WAIT_SECONDS = 120
MAX_ANSWER_CHARS = 20_000
INSUFFICIENT_EVIDENCE_ANSWER = "未取得足够的原文证据，无法回答。请缩小范围或补充正文。"
ACTIVE_TASKS: dict[str, asyncio.Task] = {}
IMAGE_TIMEOUTS: dict[str, asyncio.Task] = {}
VISION_MODEL = re.compile(
    r"(?:^|[-_/])(?:gpt-4o|gpt-4\.1|gpt-5(?:\.\d+)?|gpt-6(?:\.\d+)?|o1|o3|o4|claude-3|claude-4|gemini|qwen-vl|qwen2\.5-vl|qwen3-vl|llava|pixtral)(?:[-_/]|$)",
    re.I,
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def supports_vision(model: str) -> bool:
    """Conservative name-based capability check; unknown provider models stay text-only."""
    return bool(VISION_MODEL.search(model.strip()))


def initialize_research_tables() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS research_tasks (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
                question TEXT NOT NULL,
                model TEXT NOT NULL,
                reasoning_effort TEXT NOT NULL DEFAULT 'default',
                scope_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL,
                progress REAL NOT NULL DEFAULT 0,
                budget_json TEXT NOT NULL DEFAULT '{}',
                messages_json TEXT NOT NULL DEFAULT '[]',
                pending_image_calls_json TEXT NOT NULL DEFAULT '[]',
                answer TEXT NOT NULL DEFAULT '',
                sources_json TEXT NOT NULL DEFAULT '[]',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS research_tasks_by_paper ON research_tasks(paper_id, session_id, created_at);
            CREATE TABLE IF NOT EXISTS research_steps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
                step_key TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                detail TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL,
                UNIQUE(task_id, step_key)
            );
            CREATE TABLE IF NOT EXISTS research_evidence (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
                source_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                start_page INTEGER,
                end_page INTEGER,
                text TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                UNIQUE(task_id, source_id)
            );
            CREATE INDEX IF NOT EXISTS research_evidence_by_task ON research_evidence(task_id, id);
            CREATE TABLE IF NOT EXISTS research_image_requests (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES research_tasks(id) ON DELETE CASCADE,
                page_no INTEGER NOT NULL,
                tool_call_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                mime_type TEXT NOT NULL DEFAULT '',
                content BLOB,
                evidence_source_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE(task_id, tool_call_id)
            );
            CREATE INDEX IF NOT EXISTS research_images_by_task ON research_image_requests(task_id, status, created_at);
            """
        )
        db.execute(
            "UPDATE research_tasks SET status = 'interrupted', error = '应用关闭或重启时任务中断；可从已保存进度继续。', updated_at = ? WHERE status IN ('queued', 'running')",
            (now(),),
        )


async def shutdown_research_tasks() -> None:
    active = list(ACTIVE_TASKS.values()) + list(IMAGE_TIMEOUTS.values())
    for task in active:
        task.cancel()
    if active:
        await asyncio.gather(*active, return_exceptions=True)
    ACTIVE_TASKS.clear()
    IMAGE_TIMEOUTS.clear()
    with connect() as db:
        db.execute(
            "UPDATE research_tasks SET status = 'interrupted', error = '应用关闭时任务中断；可从已保存进度继续。', updated_at = ? WHERE status IN ('queued', 'running')",
            (now(),),
        )


def research_session_is_active(session_id: str) -> bool:
    with connect() as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'research_tasks'").fetchone():
            return False
        row = db.execute(
            "SELECT 1 FROM research_tasks WHERE session_id = ? AND status IN ('queued', 'running', 'waiting_for_image') LIMIT 1",
            (session_id,),
        ).fetchone()
    return row is not None


async def cancel_research_for_paper(paper_id: str) -> None:
    with connect() as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'research_tasks'").fetchone():
            return
        rows = db.execute("SELECT id FROM research_tasks WHERE paper_id = ? AND status IN ('queued', 'running', 'waiting_for_image')", (paper_id,)).fetchall()
        task_ids = [row["id"] for row in rows]
        if task_ids:
            db.executemany("UPDATE research_tasks SET status = 'stopped', error = '文献正在删除，研究任务已取消。', updated_at = ? WHERE id = ?",
                           [(now(), task_id) for task_id in task_ids])
    active = []
    for task_id in task_ids:
        task = ACTIVE_TASKS.get(task_id)
        if task and not task.done():
            task.cancel()
            active.append(task)
        timer = IMAGE_TIMEOUTS.pop(task_id, None)
        if timer and not timer.done():
            timer.cancel()
            active.append(timer)
    if active:
        await asyncio.gather(*active, return_exceptions=True)


class ResearchStartInput(BaseModel):
    question: str = Field(min_length=1, max_length=6000)
    session_id: str | None = None
    model: str | None = Field(default=None, max_length=160)
    reasoning_effort: str = "default"
    start_page: int | None = None
    end_page: int | None = None
    selection_context: dict[str, Any] | None = None


class ResearchImageInput(BaseModel):
    mime_type: str
    data_base64: str = Field(max_length=2_800_000)


def _json(value: Any, default: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return default


def _plan(scope: dict[str, Any], vision: bool) -> list[dict[str, str]]:
    steps = [
        {"key": "scope", "title": "确认研究范围"},
        {"key": "evidence", "title": "读取原文并收集证据"},
        {"key": "context", "title": "核对目录、笔记与批注"},
    ]
    if vision:
        steps.append({"key": "images", "title": "按需核对页面图像"})
    steps.extend([
        {"key": "analysis", "title": "分析证据"},
        {"key": "verify", "title": "校验引用与覆盖"},
        {"key": "answer", "title": "整理研究答复"},
    ])
    return steps


def _set_step(db, task_id: str, key: str, status: str, detail: str = "") -> None:
    db.execute(
        "UPDATE research_steps SET status = ?, detail = ?, updated_at = ? WHERE task_id = ? AND step_key = ?",
        (status, detail[:1200], now(), task_id, key),
    )
    rows = db.execute("SELECT status FROM research_steps WHERE task_id = ?", (task_id,)).fetchall()
    total = len(rows)
    complete = sum(row["status"] in {"completed", "skipped"} for row in rows)
    progress = round((complete / total) * 100) if total else 0
    db.execute("UPDATE research_tasks SET progress = ?, updated_at = ? WHERE id = ?", (progress, now(), task_id))


def _segment_map(db, paper_id: str, pages: list[int]) -> dict[str, list[str]]:
    page_list = sorted({page for page in pages if type(page) is int})
    result = {str(page): [] for page in page_list}
    if not page_list:
        return result
    rows = db.execute(
        "SELECT id, start_page, end_page FROM segments WHERE paper_id = ? AND start_page <= ? AND end_page >= ? ORDER BY sequence_no",
        (paper_id, page_list[-1], page_list[0]),
    ).fetchall()
    for row in rows:
        for page in page_list:
            if row["start_page"] <= page <= row["end_page"]:
                result[str(page)].append(f"S{row['id']}")
    return result


def _attach_expected_segments(db, paper_id: str, scope: dict[str, Any]) -> None:
    expected = scope.get("expected_pages")
    if expected is None:
        return
    mapping = _segment_map(db, paper_id, expected)
    unreadable = set(scope.get("unreadable_pages", []))
    readable_pages = []
    expected_segments = {}
    for page in expected:
        segment_ids = mapping.get(str(page), [])
        if segment_ids:
            readable_pages.append(page)
            expected_segments[str(page)] = segment_ids
        else:
            unreadable.add(page)
    scope["expected_pages"] = readable_pages
    scope["expected_segments"] = expected_segments
    scope["unreadable_pages"] = sorted(unreadable)


def _task_view(db, row) -> dict[str, Any]:
    task_id = row["id"]
    steps = [dict(item) for item in db.execute(
        "SELECT step_key, title, status, detail, updated_at FROM research_steps WHERE task_id = ? ORDER BY id", (task_id,)
    ).fetchall()]
    evidence_rows = db.execute(
        "SELECT source_id, kind, title, start_page, end_page, text, metadata_json FROM research_evidence WHERE task_id = ? ORDER BY id",
        (task_id,),
    ).fetchall()
    evidence = []
    citations: dict[str, dict[str, Any]] = {}
    candidate_pages: set[int] = set()
    complete_segments: set[str] = set()
    for item in evidence_rows:
        metadata = _json(item["metadata_json"], {})
        source = {
            "id": item["source_id"], "kind": item["kind"], "title": item["title"],
            "start_page": item["start_page"], "end_page": item["end_page"],
            "text": item["text"], "metadata": metadata,
        }
        evidence.append(source)
        citations[item["source_id"]] = {key: source[key] for key in ("id", "kind", "title", "start_page", "end_page")}
        if item["kind"] == "paper" and item["start_page"] is not None and item["end_page"] is not None:
            candidate_pages.update(range(item["start_page"], item["end_page"] + 1))
            if metadata.get("segment_complete"):
                complete_segments.add(item["source_id"])
    scope = _json(row["scope_json"], {})
    expected = scope.get("expected_pages")
    coverage_pages = expected if expected is not None else sorted(candidate_pages)
    segment_map = scope.get("expected_segments") or _segment_map(db, row["paper_id"], coverage_pages)
    pages = sorted(
        page for page in coverage_pages
        if segment_map.get(str(page)) and set(segment_map[str(page)]).issubset(complete_segments)
    )
    unreadable_pages = scope.get("unreadable_pages", [])
    coverage = {
        "covered_pages": pages,
        "expected_pages": expected,
        "complete": expected is not None and set(expected).issubset(pages) and not unreadable_pages,
        "text_pages": pages,
        "unreadable_pages": unreadable_pages,
    }
    if expected is not None and expected:
        coverage["percent"] = round(100 * len(set(expected) & set(pages)) / len(set(expected)))
    elif expected == []:
        coverage["percent"] = 0 if unreadable_pages else 100
    else:
        coverage["percent"] = None
    pending = [dict(item) for item in db.execute(
        "SELECT id, page_no, status FROM research_image_requests WHERE task_id = ? AND status = 'pending' ORDER BY created_at",
        (task_id,),
    ).fetchall()]
    budget = _json(row["budget_json"], {})
    return {
        "id": task_id, "paper_id": row["paper_id"], "session_id": row["session_id"],
        "question": row["question"], "model": row["model"], "reasoning_effort": row["reasoning_effort"],
        "status": row["status"], "progress": row["progress"], "plan": steps,
        "evidence": evidence, "sources": list(citations.values()), "coverage": coverage,
        "budget": budget, "answer": row["answer"], "error": row["error"],
        "image_requests": pending, "created_at": row["created_at"], "updated_at": row["updated_at"],
        "capabilities": {"image_analysis": supports_vision(row["model"])},
    }


def _store_evidence(db, task_id: str, source_id: str, kind: str, title: str = "", start_page: int | None = None,
                    end_page: int | None = None, text: str = "", metadata: dict[str, Any] | None = None) -> None:
    db.execute(
        "INSERT OR REPLACE INTO research_evidence(task_id, source_id, kind, title, start_page, end_page, text, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (task_id, source_id, kind, title[:300], start_page, end_page, text[:20_000], json.dumps(metadata or {}, ensure_ascii=False)),
    )


def _extract_sources(tool_content: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(tool_content)
    except json.JSONDecodeError:
        return []
    return data.get("excerpts", []) if isinstance(data, dict) else []


def _research_tools(vision: bool) -> list[dict[str, Any]]:
    tools = [
        {
            "type": "function", "function": {
                "name": "read_paper", "description": "读取当前文献中相关原文，返回带真实页码的证据编号。页码范围最多10页。",
                "parameters": {"type": "object", "properties": {
                    "query": {"type": "string", "maxLength": 500},
                    "start_page": {"type": "integer", "minimum": 1},
                    "end_page": {"type": "integer", "minimum": 1},
                }, "additionalProperties": False},
            },
        },
        {
            "type": "function", "function": {
                "name": "read_directory", "description": "读取当前文献各页的提取状态和原文开头，帮助定位章节；这是当前 PDF 的实际目录线索。",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        },
        {
            "type": "function", "function": {
                "name": "read_notes_annotations", "description": "只读当前文献的用户笔记和 PDF 批注；不创建或修改内容。",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        },
        {
            "type": "function", "function": {
                "name": "load_research_skill", "description": "加载论文精读或证据批判方法；技能本身不是论文证据。",
                "parameters": {"type": "object", "properties": {"skills": {
                    "type": "array", "items": {"type": "string", "enum": ["paper_close_reading", "scientific_critical_thinking"]},
                    "minItems": 1, "maxItems": 2, "uniqueItems": True,
                }}, "required": ["skills"], "additionalProperties": False},
            },
        },
    ]
    if vision:
        tools.append({
            "type": "function", "function": {
                "name": "read_page_image", "description": "查看当前 PDF 指定页的真实图像，以检查图表、公式排版或示意图。必须用1-based页码；图像由阅读器从该文献渲染。",
                "parameters": {"type": "object", "properties": {"page_no": {"type": "integer", "minimum": 1}}, "required": ["page_no"], "additionalProperties": False},
            },
        })
    tools.append({
        "type": "function", "function": {
            "name": "submit_research_answer",
            "description": "提交最终答复和逐条主张支持原句；必须每个关键事实给出可在实际证据中匹配的原句。系统会校验引用后才完成任务。",
            "parameters": {"type": "object", "properties": {
                "answer": {"type": "string", "minLength": 1, "maxLength": MAX_ANSWER_CHARS},
                "claims": {"type": "array", "minItems": 1, "maxItems": 30, "items": {
                    "type": "object", "properties": {
                        "claim": {"type": "string", "minLength": 1, "maxLength": 1000},
                        "support": {"type": "array", "minItems": 1, "maxItems": 6, "items": {
                            "type": "object", "properties": {
                                "source_id": {"type": "string", "pattern": "^(S|I|N|A)[0-9]{1,12}$"},
                                "quote": {"type": "string", "maxLength": 1200},
                            }, "required": ["source_id", "quote"], "additionalProperties": False,
                        }},
                    }, "required": ["claim", "support"], "additionalProperties": False,
                }},
            }, "required": ["answer", "claims"], "additionalProperties": False},
        },
    })
    return tools


def _strict_json_arguments(call: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    function = call.get("function")
    if not isinstance(function, dict):
        raise ai.AIError("invalid_tool_call", "研究工具调用缺少 function。")
    name = function.get("name")
    raw = function.get("arguments")
    call_id = call.get("id")
    if not isinstance(name, str) or not isinstance(raw, str) or not isinstance(call_id, str) or len(call_id) > 200:
        raise ai.AIError("invalid_tool_call", "研究工具调用格式无效。")
    try:
        arguments = json.loads(raw)
    except json.JSONDecodeError:
        raise ai.AIError("invalid_tool_call", "研究工具参数不是有效 JSON。") from None
    if not isinstance(arguments, dict):
        raise ai.AIError("invalid_tool_call", "研究工具参数必须是对象。")
    return call_id, name, arguments


def _message(result: dict[str, Any]) -> dict[str, Any]:
    message = result.get("message")
    if isinstance(message, dict):
        public_message = dict(message)
        public_message.pop("reasoning", None)
        public_message.pop("reasoning_content", None)
        return public_message
    return {"role": "assistant", "content": result.get("content") or ""}


def _citation_ids(answer: str) -> set[str]:
    return set(re.findall(r"\[((?:S|I|N|A)\d{1,12})\]", answer))


def _is_full_request(question: str) -> bool:
    return bool(re.search(r"全文|整篇|全篇|全面(?:阅读|分析|精读)|逐页|whole paper|full paper|entire paper|comprehensive", question, re.I))


def _scope_for(value: ResearchStartInput, paper: Any) -> dict[str, Any]:
    if value.start_page is not None or value.end_page is not None:
        if type(value.start_page) is not int or type(value.end_page) is not int or not (1 <= value.start_page <= value.end_page <= paper["page_count"]):
            raise HTTPException(status_code=422, detail="研究页码范围无效。")
        if value.end_page - value.start_page >= 10:
            raise HTTPException(status_code=422, detail="单次研究页码范围最多10页。")
        with connect() as db:
            rows = db.execute("SELECT page_no, extraction_status FROM pages WHERE paper_id = ? AND page_no BETWEEN ? AND ? ORDER BY page_no",
                              (paper["id"], value.start_page, value.end_page)).fetchall()
        return {"kind": "pages", "start_page": value.start_page, "end_page": value.end_page,
                "expected_pages": [row["page_no"] for row in rows if row["extraction_status"] == "text"],
                "unreadable_pages": [row["page_no"] for row in rows if row["extraction_status"] in {"needs_ocr", "needs_attention"}]}
    selection = value.selection_context
    if isinstance(selection, dict):
        page = selection.get("page_no")
        quote = selection.get("selected_text")
        if type(page) is int and 1 <= page <= paper["page_count"] and isinstance(quote, str) and quote.strip():
            with connect() as db:
                page_row = db.execute("SELECT extraction_status FROM pages WHERE paper_id = ? AND page_no = ?", (paper["id"], page)).fetchone()
            can_read_text = page_row and page_row["extraction_status"] == "text"
            return {"kind": "selection", "start_page": page, "end_page": page,
                    "expected_pages": [page] if can_read_text else [],
                    "unreadable_pages": [] if can_read_text else [page], "selected_text": quote[:10000]}
    if _is_full_request(value.question):
        with connect() as db:
            rows = db.execute("SELECT page_no, extraction_status FROM pages WHERE paper_id = ? ORDER BY page_no", (paper["id"],)).fetchall()
        expected = [row["page_no"] for row in rows if row["extraction_status"] == "text"]
        unreadable = [row["page_no"] for row in rows if row["extraction_status"] in {"needs_ocr", "needs_attention"}]
        return {"kind": "full", "start_page": 1, "end_page": paper["page_count"],
                "expected_pages": expected, "unreadable_pages": unreadable}
    return {"kind": "question", "expected_pages": None}


def _scope_instruction(scope: dict[str, Any]) -> str:
    if scope["kind"] == "pages":
        return f"严格将研究范围限制在第 {scope['start_page']}–{scope['end_page']} 页。"
    if scope["kind"] == "selection":
        return f"优先回答当前选区所在的第 {scope['start_page']} 页，选中文字为：\n{scope['selected_text']}"
    if scope["kind"] == "full":
        return "用户要求全文研究。必须读取并覆盖全文的可提取原文；遇到预算或扫描页限制时，在答复中明确未覆盖范围，不得声称通读全文。"
    return "用户未限定具体页码。围绕问题检索相关原文；不要把局部结果称为全文覆盖。"


def register(
    app: FastAPI,
    authorize: Callable,
    require_paper: Callable[[str], Any],
    read_paper_evidence: Callable[[str, dict[str, Any], int], tuple[str, dict[str, dict[str, int]]]],
    stream_config_for: Callable[[str | None, Any, str | None], tuple[str, tuple[str, str, str], str]],
) -> None:
    router = APIRouter()

    def _get_task(db, paper_id: str, task_id: str):
        row = db.execute("SELECT * FROM research_tasks WHERE id = ? AND paper_id = ?", (task_id, paper_id)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="找不到这项深度研究任务。")
        return row

    def _start_worker(task_id: str) -> None:
        existing = ACTIVE_TASKS.get(task_id)
        if existing and not existing.done():
            return
        task = asyncio.create_task(_run_task(task_id))
        ACTIVE_TASKS[task_id] = task
        task.add_done_callback(lambda done, key=task_id: ACTIVE_TASKS.pop(key, None) if ACTIVE_TASKS.get(key) is done else None)

    async def _run_task(task_id: str) -> None:
        try:
            await _execute(task_id)
        except asyncio.CancelledError:
            with connect() as db:
                row = db.execute("SELECT status FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
                if row and row["status"] in {"queued", "running"}:
                    db.execute("UPDATE research_tasks SET status = 'interrupted', error = '任务执行中断；可从已保存进度继续。', updated_at = ? WHERE id = ?", (now(), task_id))
            raise
        except Exception as exc:
            with connect() as db:
                row = db.execute("SELECT status FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
                if row and row["status"] == "running":
                    message = str(exc)[:800] or "研究任务失败。"
                    db.execute("UPDATE research_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", (message, now(), task_id))
                    _set_step(db, task_id, "analysis", "failed", message)

    async def _execute(task_id: str) -> None:
        with connect() as db:
            task = db.execute("SELECT * FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
            if not task or task["status"] in {"stopped", "completed", "failed", "budget_exhausted"}:
                return
            db.execute("UPDATE research_tasks SET status = 'running', error = '', updated_at = ? WHERE id = ?", (now(), task_id))
            paper_id = task["paper_id"]
            question = task["question"]
            scope = _json(task["scope_json"], {})
            vision = supports_vision(task["model"])
            budget = _json(task["budget_json"], {"model_calls": 0, "tool_calls": 0, "input_chars": 0,
                                                   "max_model_calls": MAX_MODEL_CALLS, "max_tool_calls": MAX_TOOL_CALLS,
                                                   "max_input_chars": MAX_INPUT_CHARS})
            messages = _json(task["messages_json"], [])
            pending_images = _json(task["pending_image_calls_json"], [])
            model, config, protocol = stream_config_for(task["model"], require_paper(paper_id))
            effort = task["reasoning_effort"]
            created_at = task["created_at"]
            if not messages:
                _set_step(db, task_id, "scope", "completed", f"{scope['kind']} 范围已确认。")
                _set_step(db, task_id, "evidence", "running", "研究代理正在检索原文。")
                system = (
                    "你是 Folio 的单篇文献深度研究助手。只根据本地文献、用户笔记和批注回答，不调用外网，不写入任何笔记或批注。"
                    "先按问题决定是否加载 load_research_skill，再读取实际原文；可读取目录和笔记/批注；图表或公式视觉细节需要时读取页面图像。"
                    "每个重要本文事实都必须用工具返回的来源编号引用。不要显示思考过程。区分作者结论、解释和推测。"
                    "最终必须调用 submit_research_answer 提交答案与关键主张的逐条支持原句；不能只输出普通文本。答案中的所有分析正文都必须逐条列入 claims，标题和格式标记除外。"
                    "每个关键主张列出来源编号和逐字摘录，摘录必须来自相应工具结果；若图像支持视觉观察，可使用实际读取的图像来源并说明观察。"
                    "答案中的每个事实段落都要带工具真实返回的 [S数字]、[I数字]、[N数字] 或 [A数字]。"
                    "如果工具没有返回充分证据，应说清已读范围与限制。\n" + _scope_instruction(scope)
                )
                user = f"研究问题：{question}\n\n请先收集证据，再按证据回答。"
                if scope.get("selected_text"):
                    user += "\n\n当前选区：\n" + scope["selected_text"]
                messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
                db.execute("UPDATE research_tasks SET messages_json = ?, updated_at = ? WHERE id = ?",
                           (json.dumps(messages, ensure_ascii=False), now(), task_id))

        if pending_images:
            with connect() as db:
                for pending in pending_images:
                    request = db.execute(
                        "SELECT * FROM research_image_requests WHERE id = ? AND task_id = ?", (pending["request_id"], task_id)
                    ).fetchone()
                    if not request or request["status"] != "received" or not request["content"]:
                        db.execute("UPDATE research_tasks SET status = 'waiting_for_image', updated_at = ? WHERE id = ?", (now(), task_id))
                        return
                    tool_result = {
                        "role": "tool", "tool_call_id": pending["tool_call_id"], "name": "read_page_image",
                        "content": [
                            {"type": "text", "text": f"已读取当前文献原始 PDF 第 {request['page_no']} 页图像，来源 [{request['evidence_source_id']}]。图像由阅读器从当前文献渲染。"},
                            {"type": "research_image", "request_id": request["id"]},
                        ],
                    }
                    messages.append(tool_result)
                db.execute("UPDATE research_tasks SET pending_image_calls_json = '[]', messages_json = ?, updated_at = ? WHERE id = ?",
                           (json.dumps(messages, ensure_ascii=False), now(), task_id))
                _set_step(db, task_id, "images", "completed", f"已核对 {len(pending_images)} 张实际 PDF 页面图像。")
            # Image bytes are hydrated only for the call below; persisted placeholders are rebuilt from requests.

        tools = _research_tools(vision)
        while True:
            with connect() as db:
                row = db.execute("SELECT * FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
                if not row or row["status"] in {"stopped", "completed", "failed"}:
                    return
                budget = _json(row["budget_json"], budget)
                messages = _json(row["messages_json"], messages)
                call_count = budget.get("model_calls", 0)
                char_count = sum(len(json.dumps(message, ensure_ascii=False)) for message in messages)
                elapsed = max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(created_at)).total_seconds())
                if elapsed >= MAX_TASK_SECONDS:
                    db.execute("UPDATE research_tasks SET status = 'budget_exhausted', budget_json = ?, messages_json = ?, error = ?, updated_at = ? WHERE id = ?",
                               (json.dumps(budget), json.dumps(messages, ensure_ascii=False), "已达到研究时间预算；已保存当前计划和证据。", now(), task_id))
                    _set_step(db, task_id, "analysis", "paused", "研究时间预算已用尽。")
                    return
                if call_count >= MAX_MODEL_CALLS or char_count > MAX_INPUT_CHARS:
                    db.execute("UPDATE research_tasks SET status = 'budget_exhausted', budget_json = ?, messages_json = ?, error = ?, updated_at = ? WHERE id = ?",
                               (json.dumps(budget), json.dumps(messages, ensure_ascii=False), "已达到研究调用或输入预算；已保存当前计划和证据。", now(), task_id))
                    _set_step(db, task_id, "analysis", "paused", "研究预算已用尽，进度与证据已保存。")
                    return
                hydrated = await _hydrate_messages(messages, task_id)
                budget["model_calls"] = call_count + 1
                budget["input_chars"] = min(MAX_INPUT_CHARS, budget.get("input_chars", 0) + char_count)
                budget["elapsed_seconds"] = int(elapsed)
                db.execute("UPDATE research_tasks SET budget_json = ?, messages_json = ?, updated_at = ? WHERE id = ?",
                           (json.dumps(budget), json.dumps(messages, ensure_ascii=False), now(), task_id))
                _set_step(db, task_id, "analysis", "running", f"已执行 {budget['model_calls']} 次模型调用。")
            result = await asyncio.to_thread(
                ai.chat_completion, hydrated, operation="deep_research", paper_id=paper_id, model=model,
                config=config, protocol=protocol, reasoning_effort=effort, tools=tools,
            )
            assistant = _message(result)
            tool_calls = result.get("tool_calls") if isinstance(result.get("tool_calls"), list) else assistant.get("tool_calls", [])
            messages.append(assistant)
            if not tool_calls:
                with connect() as db:
                    db.execute("UPDATE research_tasks SET status = 'failed', error = ?, messages_json = ?, updated_at = ? WHERE id = ?",
                               ("模型未提交可核验的结构化答案。", json.dumps(messages, ensure_ascii=False), now(), task_id))
                    _set_step(db, task_id, "verify", "failed", "最终答案没有提供逐条主张和原句支持。")
                return
            image_calls: list[dict[str, Any]] = []
            for call in tool_calls:
                call_id, name, arguments = _strict_json_arguments(call)
                with connect() as db:
                    latest = db.execute("SELECT status, budget_json FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
                    if not latest or latest["status"] == "stopped":
                        return
                    budget = _json(latest["budget_json"], budget)
                    budget["tool_calls"] = budget.get("tool_calls", 0) + 1
                    if budget["tool_calls"] > MAX_TOOL_CALLS:
                        db.execute("UPDATE research_tasks SET status = 'budget_exhausted', budget_json = ?, error = ?, updated_at = ? WHERE id = ?",
                                   (json.dumps(budget), "已达到研究工具调用预算；已保存当前计划和证据。", now(), task_id))
                        _set_step(db, task_id, "analysis", "paused", "研究工具预算已用尽。")
                        return
                    db.execute("UPDATE research_tasks SET budget_json = ? WHERE id = ?", (json.dumps(budget), task_id))
                if name == "read_page_image" and vision:
                    page_no = arguments.get("page_no")
                    paper = require_paper(paper_id)
                    if type(page_no) is not int or not (1 <= page_no <= paper["page_count"]):
                        raise ai.AIError("invalid_tool_call", "请求的 PDF 页码无效。")
                    if scope.get("start_page") and not (scope["start_page"] <= page_no <= scope["end_page"]):
                        raise ai.AIError("invalid_tool_call", "请求的图片页码超出当前研究范围。")
                    request_id = uuid.uuid4().hex
                    with connect() as db:
                        existing_images = db.execute("SELECT count(*) AS count FROM research_image_requests WHERE task_id = ?", (task_id,)).fetchone()["count"]
                        if existing_images >= MAX_IMAGE_COUNT:
                            messages.append({"role": "tool", "tool_call_id": call_id, "name": name,
                                             "content": "本任务页面图像预算已用尽；请基于已读取的图像和文本继续。"})
                            continue
                        db.execute(
                            "INSERT INTO research_image_requests(id, task_id, page_no, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?)",
                            (request_id, task_id, page_no, call_id, now()),
                        )
                    image_calls.append({"request_id": request_id, "tool_call_id": call_id})
                    continue
                if name == "submit_research_answer":
                    accepted, verification = _validate_submission(task_id, arguments)
                    messages.append({"role": "tool", "tool_call_id": call_id, "name": name,
                                     "content": json.dumps(verification, ensure_ascii=False)})
                    with connect() as db:
                        budget = _json(db.execute("SELECT budget_json FROM research_tasks WHERE id = ?", (task_id,)).fetchone()["budget_json"], {})
                        budget["verification_attempts"] = budget.get("verification_attempts", 0) + 1
                        db.execute("UPDATE research_tasks SET budget_json = ?, messages_json = ?, updated_at = ? WHERE id = ?",
                                   (json.dumps(budget), json.dumps(messages, ensure_ascii=False), now(), task_id))
                        if accepted:
                            _finish_submission(db, task_id, arguments, verification, messages)
                            return
                        if budget["verification_attempts"] >= 3:
                            db.execute("UPDATE research_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
                                       ("在三次尝试内未通过主张与原文支持校验；已保存计划和证据。", now(), task_id))
                            _set_step(db, task_id, "verify", "failed", verification.get("message", "引用核验失败。"))
                            return
                        _set_step(db, task_id, "verify", "running", verification.get("message", "请修正答复后重试。"))
                    continue
                content = await _run_tool(name, arguments, task_id, paper_id, task, scope, read_paper_evidence)
                messages.append({"role": "tool", "tool_call_id": call_id, "name": name, "content": content})
            if image_calls:
                with connect() as db:
                    db.execute("UPDATE research_tasks SET pending_image_calls_json = ?, messages_json = ?, status = 'waiting_for_image', updated_at = ? WHERE id = ?",
                               (json.dumps(image_calls), json.dumps(messages, ensure_ascii=False), now(), task_id))
                    _set_step(db, task_id, "images", "running", "等待阅读器从当前 PDF 渲染模型请求的页面图像。")
                previous = IMAGE_TIMEOUTS.pop(task_id, None)
                if previous and not previous.done():
                    previous.cancel()
                timer = asyncio.create_task(_expire_image_wait(task_id, image_calls, _start_worker))
                IMAGE_TIMEOUTS[task_id] = timer
                return
            with connect() as db:
                db.execute("UPDATE research_tasks SET messages_json = ?, updated_at = ? WHERE id = ?",
                           (json.dumps(messages, ensure_ascii=False), now(), task_id))

    async def _hydrate_messages(messages: list[dict[str, Any]], task_id: str) -> list[dict[str, Any]]:
        hydrated = json.loads(json.dumps(messages, ensure_ascii=False))
        with connect() as db:
            rows = db.execute(
                "SELECT id, mime_type, content, evidence_source_id FROM research_image_requests WHERE task_id = ? AND status = 'received'",
                (task_id,),
            ).fetchall()
        images = {row["id"]: row for row in rows}
        output: list[dict[str, Any]] = []
        pending_visual: list[dict[str, Any]] = []
        for index, message in enumerate(hydrated):
            content = message.get("content")
            if isinstance(content, list):
                text_parts: list[str] = []
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "research_image":
                        row = images.get(part.get("request_id"))
                        if row:
                            encoded = base64.b64encode(bytes(row["content"])).decode("ascii")
                            pending_visual.extend([
                                {"type": "text", "text": f"这是实际读取的 PDF 页面图像，来源 [{row['evidence_source_id']}]。"},
                                {"type": "image_url", "image_url": {"url": f"data:{row['mime_type']};base64,{encoded}"}},
                            ])
                    elif isinstance(part, dict) and part.get("type") == "text":
                        text_parts.append(part.get("text", ""))
                message["content"] = "\n".join(text_parts) or "页面图像已作为独立多模态消息提供。"
            output.append(message)
            next_is_tool = index + 1 < len(hydrated) and hydrated[index + 1].get("role") == "tool"
            if message.get("role") == "tool" and not next_is_tool and pending_visual:
                output.append({"role": "user", "content": pending_visual})
                pending_visual = []
        if pending_visual:
            output.append({"role": "user", "content": pending_visual})
        return output

    def _save_paper_excerpts(db, task_id: str, paper_id: str, excerpts: list[dict[str, Any]]) -> None:
        for excerpt in excerpts:
            source_id = excerpt.get("source_id")
            if not isinstance(source_id, str) or not re.fullmatch(r"S\d{1,12}", source_id):
                continue
            segment = db.execute(
                "SELECT id, original_text FROM segments WHERE id = ? AND paper_id = ?",
                (int(source_id[1:]), paper_id),
            ).fetchone()
            text = excerpt.get("text", "")
            complete = bool(segment and isinstance(text, str) and text == segment["original_text"].strip())
            _store_evidence(
                db, task_id, source_id, "paper", f"原文第 {excerpt.get('start_page')} 页",
                excerpt.get("start_page"), excerpt.get("end_page"), text,
                {"segment_id": segment["id"] if segment else None, "segment_complete": complete, "truncated": not complete},
            )

    def _read_scoped_segments(task_id: str, paper_id: str, segment_map: dict[str, list[str]], pages: list[int]) -> str:
        expected_ids = list(dict.fromkeys(
            source_id for page in sorted(pages)
            for source_id in segment_map.get(str(page), [])
        ))
        with connect() as db:
            seen_rows = db.execute(
                "SELECT source_id, metadata_json FROM research_evidence WHERE task_id = ? AND kind = 'paper'",
                (task_id,),
            ).fetchall()
            seen = {row["source_id"] for row in seen_rows if _json(row["metadata_json"], {}).get("segment_complete")}
            remaining = [source_id for source_id in expected_ids if source_id not in seen]
            candidate_ids = remaining[:8]
            rows = []
            if candidate_ids:
                placeholders = ",".join("?" for _ in candidate_ids)
                rows = db.execute(
                    f"SELECT id, start_page, end_page, original_text FROM segments WHERE paper_id = ? AND id IN ({placeholders}) ORDER BY sequence_no",
                    (paper_id, *(int(source_id[1:]) for source_id in candidate_ids)),
                ).fetchall()
            selected = []
            chars = 0
            for row in rows:
                if selected and chars + len(row["original_text"]) > 10_500:
                    break
                selected.append(row)
                chars += len(row["original_text"])
            excerpts = [{
                "citation": f"[S{row['id']}]", "source_id": f"S{row['id']}",
                "start_page": row["start_page"], "end_page": row["end_page"], "text": row["original_text"].strip(),
            } for row in selected]
            _save_paper_excerpts(db, task_id, paper_id, excerpts)
            _set_step(db, task_id, "evidence", "running", f"已读取 {len(excerpts)} 个原文段落；覆盖按全部段落编号核对。")
        read_ids = {excerpt["source_id"] for excerpt in excerpts}
        missing_count = sum(source_id not in seen and source_id not in read_ids for source_id in expected_ids)
        return json.dumps({
            "status": "ok" if excerpts else "no_evidence", "excerpts": excerpts,
            "truncated": False, "coverage_complete": missing_count == 0,
            "remaining_segments": missing_count,
        }, ensure_ascii=False)

    async def _run_tool(name: str, arguments: dict[str, Any], task_id: str, paper_id: str, task: Any,
                        scope: dict[str, Any], read_fn) -> str:
        if name == "read_paper":
            allowed = {"query", "start_page", "end_page"}
            if set(arguments) - allowed:
                raise ai.AIError("invalid_tool_call", "读取原文参数无效。")
            query = arguments.get("query", "")
            if not isinstance(query, str) or len(query) > 500:
                raise ai.AIError("invalid_tool_call", "原文检索词格式无效。")
            start_page, end_page = arguments.get("start_page"), arguments.get("end_page")
            scoped_read = scope["kind"] in {"full", "pages", "selection"} and not query
            target_pages: list[int] = []
            if scope["kind"] == "full" and scoped_read and start_page is None and end_page is None:
                target_pages = scope.get("expected_pages", [])
            elif scope["kind"] in {"pages", "selection"}:
                if start_page is None and end_page is None:
                    start_page, end_page = scope["start_page"], scope["end_page"]
                if (type(start_page) is not int or type(end_page) is not int or start_page < scope["start_page"]
                        or end_page > scope["end_page"]):
                    raise ai.AIError("invalid_tool_call", "原文读取页码超出当前研究范围。")
            if start_page is not None or end_page is not None:
                if type(start_page) is not int or type(end_page) is not int or start_page < 1 or end_page < start_page or end_page - start_page >= 10:
                    raise ai.AIError("invalid_tool_call", "原文读取范围最多10页。")
                if scoped_read:
                    target_pages = list(range(start_page, end_page + 1))
            if scope["kind"] in {"pages", "selection"} or (scope["kind"] == "full" and start_page is not None):
                query = ""
                scoped_read = True
            if scoped_read and not target_pages and type(start_page) is int and type(end_page) is int:
                target_pages = list(range(start_page, end_page + 1))
            if scoped_read:
                segment_map = scope.get("expected_segments") or {}
                return _read_scoped_segments(task_id, paper_id, segment_map, target_pages)
            content, _sources = read_fn(paper_id, {"query": query, "start_page": start_page, "end_page": end_page}, require_paper(paper_id)["page_count"])
            excerpts = _extract_sources(content)
            with connect() as db:
                _save_paper_excerpts(db, task_id, paper_id, excerpts)
                _set_step(db, task_id, "evidence", "running", f"已读取 {len(excerpts)} 条原文证据。")
            return content
        if name == "read_directory":
            if arguments:
                raise ai.AIError("invalid_tool_call", "目录读取不接受参数。")
            with connect() as db:
                rows = db.execute(
                    "SELECT p.page_no, p.extraction_status, p.text_chars, s.id, s.original_text FROM pages p "
                    "LEFT JOIN segments s ON s.paper_id = p.paper_id AND s.start_page = p.page_no "
                    "WHERE p.paper_id = ? ORDER BY p.page_no, s.sequence_no", (paper_id,),
                ).fetchall()
            pages: dict[int, dict[str, Any]] = {}
            for row in rows:
                entry = pages.setdefault(row["page_no"], {"page_no": row["page_no"], "status": row["extraction_status"], "text_chars": row["text_chars"], "opening": ""})
                if not entry["opening"] and row["original_text"]:
                    entry["opening"] = row["original_text"][:350]
            return json.dumps({"pages": list(pages.values())}, ensure_ascii=False)
        if name == "read_notes_annotations":
            if arguments:
                raise ai.AIError("invalid_tool_call", "笔记与批注读取不接受参数。")
            with connect() as db:
                notes = db.execute("SELECT id, title, text, updated_at FROM paper_note_tabs WHERE paper_id = ? ORDER BY created_at, id", (paper_id,)).fetchall()
                annotations = db.execute("SELECT id, page_no, selected_text, comment, kind, created_at FROM paper_annotations WHERE paper_id = ? ORDER BY page_no, created_at, id", (paper_id,)).fetchall()
                for index, note in enumerate(notes, start=1):
                    _store_evidence(db, task_id, f"N{index}", "note", note["title"], text=note["text"], metadata={"note_id": note["id"], "updated_at": note["updated_at"]})
                for index, annotation in enumerate(annotations, start=1):
                    _store_evidence(db, task_id, f"A{index}", "annotation", f"第 {annotation['page_no']} 页批注",
                                    annotation["page_no"], annotation["page_no"], annotation["comment"],
                                    {"annotation_id": annotation["id"], "selected_text": annotation["selected_text"], "kind": annotation["kind"]})
            _set_step_for_task(task_id, "context", "completed", f"已读取 {len(notes)} 条笔记和 {len(annotations)} 条批注；均为只读。")
            return json.dumps({
                "notes": [{"source_id": f"N{index}", "citation": f"[N{index}]", "title": row["title"], "text": row["text"]} for index, row in enumerate(notes, start=1)],
                "annotations": [{"source_id": f"A{index}", "citation": f"[A{index}]", "page_no": row["page_no"], "selected_text": row["selected_text"], "comment": row["comment"], "kind": row["kind"]} for index, row in enumerate(annotations, start=1)],
            }, ensure_ascii=False)
        if name == "load_research_skill":
            from .research_skills import load_research_skill
            return load_research_skill(arguments)
        raise ai.AIError("invalid_tool_call", f"不支持的研究工具：{name}")

    def _set_step_for_task(task_id: str, key: str, status: str, detail: str = "") -> None:
        with connect() as db:
            _set_step(db, task_id, key, status, detail)

    def _validate_submission(task_id: str, payload: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
        answer = payload.get("answer")
        claims = payload.get("claims")
        if not isinstance(answer, str) or not answer.strip() or len(answer) > MAX_ANSWER_CHARS or not isinstance(claims, list):
            return False, {"status": "rejected", "message": "答案格式无效或超过长度上限，请缩短后重新提交。"}
        with connect() as db:
            task = db.execute("SELECT paper_id, scope_json FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
            evidence_rows = db.execute("SELECT * FROM research_evidence WHERE task_id = ?", (task_id,)).fetchall()
            image_rows = db.execute("SELECT evidence_source_id, content FROM research_image_requests WHERE task_id = ? AND status = 'received'", (task_id,)).fetchall()
        evidence = {row["source_id"]: row for row in evidence_rows}
        images = {row["evidence_source_id"]: row["content"] for row in image_rows}
        citations = _citation_ids(answer)
        if citations - set(evidence):
            return False, {"status": "rejected", "message": "答案引用了未读取的来源编号，请删除或读取对应证据。", "invalid_sources": sorted(citations - set(evidence))}
        if not evidence and not claims:
            scope = _json(task["scope_json"], {})
            return True, {
                "status": "accepted", "message": "没有足够的原文证据，已返回固定的证据不足提示。",
                "server_answer": INSUFFICIENT_EVIDENCE_ANSWER, "insufficient_evidence": True,
                "validated_claims": 0, "validated_citations": [],
                "unreadable_pages": scope.get("unreadable_pages", []),
            }
        if not claims:
            return False, {"status": "rejected", "message": "有可用证据时，答案必须提供逐条核验的主张。"}
        if evidence and not citations:
            return False, {"status": "rejected", "message": "有已读取证据但答案没有引用，请为事实段落添加来源编号。"}
        for paragraph in re.split(r"\n\s*\n", answer.strip()):
            content = re.sub(r"^\s{0,3}(?:#{1,6}\s*|[-*+]\s*)", "", paragraph.strip())
            if len(content) > 80 and not _citation_ids(content):
                return False, {"status": "rejected", "message": "每个事实段落都需要至少一个来源编号。"}
        normalized = lambda text: re.sub(r"\s+", " ", text.replace("\u00ad", "").strip()).casefold()
        supported: set[str] = set()
        for claim in claims:
            if not isinstance(claim, dict) or not isinstance(claim.get("claim"), str) or not isinstance(claim.get("support"), list):
                return False, {"status": "rejected", "message": "主张支持列表格式无效。"}
            if normalized(claim["claim"]) not in normalized(answer):
                return False, {"status": "rejected", "message": "逐条核验的主张必须能在最终答案中找到。"}
            for support in claim["support"]:
                source_id = support.get("source_id") if isinstance(support, dict) else None
                quote = support.get("quote", "") if isinstance(support, dict) else ""
                source = evidence.get(source_id)
                if not source:
                    return False, {"status": "rejected", "message": "主张引用了本任务未读取的来源。", "invalid_sources": [source_id]}
                if source["kind"] == "image":
                    if not images.get(source_id):
                        return False, {"status": "rejected", "message": "图像主张没有对应的实际 PDF 页面图像。"}
                elif not isinstance(quote, str) or len(quote.strip()) < 8 or normalized(quote) not in normalized(source["text"]):
                    return False, {"status": "rejected", "message": f"来源 {source_id} 的支持摘录没有逐字出现在已读取内容中。"}
                supported.add(source_id)
        if citations - supported:
            return False, {"status": "rejected", "message": "答案引用没有对应的逐条主张支持摘录。", "unsupported_sources": sorted(citations - supported)}
        answer_lines = []
        for line in answer.splitlines():
            if re.match(r"^\s{0,3}#{1,6}(?:\s|$)", line):
                continue
            line = re.sub(r"^\s{0,3}(?:[-*+]|\d+[.)]|>)\s+", "", line)
            line = re.sub(r"\[(?:S|I|N|A)\d{1,12}\]", " ", line)
            line = re.sub(r"(?<!\\)[*_`~]+", "", line)
            answer_lines.append(line)
        remaining = normalized("\n".join(answer_lines))
        for claim in claims:
            claim_text = normalized(re.sub(r"\[(?:S|I|N|A)\d{1,12}\]", " ", claim["claim"]))
            claim_text = re.sub(r"(?<!\\)[*_`~]+", "", claim_text)
            if claim_text:
                remaining = remaining.replace(claim_text, " ", 1)
        if re.search(r"\w", remaining, re.UNICODE):
            return False, {"status": "rejected", "message": "答案包含未列入逐条核验主张的正文，请删除或为其补充主张与支持摘录。"}
        scope = _json(task["scope_json"], {})
        expected_pages = scope.get("expected_pages")
        segment_map = scope.get("expected_segments")
        if expected_pages is not None and segment_map is None:
            with connect() as db:
                segment_map = _segment_map(db, task["paper_id"], expected_pages)
        complete_segments = {
            row["source_id"] for row in evidence_rows
            if row["kind"] == "paper" and _json(row["metadata_json"], {}).get("segment_complete")
        }
        missing = sorted(
            page for page in (expected_pages or [])
            if not segment_map.get(str(page)) or not set(segment_map[str(page)]).issubset(complete_segments)
        ) if expected_pages is not None else []
        if missing:
            missing_segments = sorted({
                source_id for page in missing for source_id in segment_map.get(str(page), [])
                if source_id not in complete_segments
            })
            return False, {"status": "rejected", "message": "全文/指定范围尚未完整读取。请读取未覆盖页的全部原文段落，再提交答案。",
                           "missing_pages": missing, "missing_segments": missing_segments}
        return True, {"status": "accepted", "message": "引用编号、段落引用、关键主张及其逐字支持摘录均已核验。",
                      "validated_claims": len(claims), "validated_citations": sorted(citations),
                      "unreadable_pages": scope.get("unreadable_pages", [])}

    def _finish_submission(db, task_id: str, payload: dict[str, Any], verification: dict[str, Any], messages: list[dict[str, Any]]) -> None:
        task = db.execute("SELECT scope_json FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
        scope = _json(task["scope_json"], {})
        answer = (verification.get("server_answer") or payload["answer"]).strip()
        stored_messages = messages
        if verification.get("insufficient_evidence"):
            stored_messages = json.loads(json.dumps(messages, ensure_ascii=False))
            for message in stored_messages:
                for call in message.get("tool_calls", []):
                    function = call.get("function", {})
                    if function.get("name") == "submit_research_answer":
                        function["arguments"] = json.dumps({"answer": answer, "claims": []}, ensure_ascii=False)
        unreadable = verification.get("unreadable_pages", [])
        if unreadable:
            answer += "\n\n覆盖限制：以下页没有可提取的正文文本，本次无法核验其内容：" + "、".join(map(str, unreadable)) + "。"
        if len(answer) > MAX_ANSWER_CHARS:
            db.execute("UPDATE research_tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
                       ("经覆盖说明补充后，答案超过20,000字上限；请缩短研究问题后重试。", now(), task_id))
            _set_step(db, task_id, "verify", "failed", "答案超过显示长度上限，未截断保存。")
            return
        citations = _citation_ids(payload["answer"])
        sources = [dict(item) for item in db.execute(
            "SELECT source_id AS id, kind, title, start_page, end_page FROM research_evidence WHERE task_id = ? AND source_id IN (%s) ORDER BY id" % (",".join("?" for _ in citations) or "NULL"),
            [task_id, *sorted(citations)],
        ).fetchall()]
        evidence_count = db.execute("SELECT count(*) AS count FROM research_evidence WHERE task_id = ?", (task_id,)).fetchone()["count"]
        _set_step(db, task_id, "evidence", "completed", f"已保存并核验 {evidence_count} 条来源证据。")
        analysis_detail = "没有足够的原文证据，未生成可核验主张。" if verification.get("insufficient_evidence") else "关键主张均关联到实际读取的来源。"
        _set_step(db, task_id, "analysis", "completed", analysis_detail)
        _set_step(db, task_id, "verify", "completed", f"已验证 {verification['validated_claims']} 条主张和 {len(citations)} 个引用。")
        _set_step(db, task_id, "answer", "completed", "最终答复已整理。")
        for key in ("context", "images"):
            step = db.execute("SELECT status FROM research_steps WHERE task_id = ? AND step_key = ?", (task_id, key)).fetchone()
            if step and step["status"] == "pending":
                _set_step(db, task_id, key, "skipped", "本任务未调用该只读工具。")
        status = "partial" if unreadable or verification.get("insufficient_evidence") else "completed"
        budget = _json(db.execute("SELECT budget_json FROM research_tasks WHERE id = ?", (task_id,)).fetchone()["budget_json"], {})
        budget["verification"] = {key: verification[key] for key in ("validated_claims", "validated_citations", "unreadable_pages", "insufficient_evidence") if key in verification}
        db.execute("UPDATE research_tasks SET status = ?, answer = ?, sources_json = ?, messages_json = ?, budget_json = ?, error = '', updated_at = ? WHERE id = ?",
                   (status, answer, json.dumps(sources, ensure_ascii=False), json.dumps(stored_messages, ensure_ascii=False), json.dumps(budget), now(), task_id))

    async def _expire_image_wait(task_id: str, calls: list[dict[str, str]], start_worker: Callable[[str], None]) -> None:
        try:
            await asyncio.sleep(MAX_IMAGE_WAIT_SECONDS)
            with connect() as db:
                row = db.execute("SELECT status, messages_json FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
                if not row or row["status"] != "waiting_for_image":
                    return
                messages = _json(row["messages_json"], [])
                for call in calls:
                    request = db.execute("SELECT * FROM research_image_requests WHERE id = ? AND task_id = ?", (call["request_id"], task_id)).fetchone()
                    if request and request["status"] == "received":
                        messages.append({"role": "tool", "tool_call_id": call["tool_call_id"], "name": "read_page_image",
                                         "content": [
                                             {"type": "text", "text": f"已读取 PDF 第 {request['page_no']} 页图像，来源 [{request['evidence_source_id']}]。"},
                                             {"type": "research_image", "request_id": request["id"]},
                                         ]})
                    elif request and request["status"] == "pending":
                        db.execute("UPDATE research_image_requests SET status = 'timed_out' WHERE id = ?", (call["request_id"],))
                        messages.append({"role": "tool", "tool_call_id": call["tool_call_id"], "name": "read_page_image",
                                         "content": "页面图像读取超时，未取得视觉证据。请基于可用文本继续，并说明视觉内容未核验。"})
                db.execute("UPDATE research_tasks SET pending_image_calls_json = '[]', messages_json = ?, status = 'queued', error = ?, updated_at = ? WHERE id = ?",
                           (json.dumps(messages, ensure_ascii=False), "页面图像请求等待超时；任务继续使用可用文本。", now(), task_id))
                _set_step(db, task_id, "images", "skipped", "等待超时，未获得图像证据。")
            start_worker(task_id)
        except asyncio.CancelledError:
            raise
        finally:
            IMAGE_TIMEOUTS.pop(task_id, None)

    @router.get("/papers/{paper_id}/research", dependencies=[Depends(authorize)])
    def list_tasks(paper_id: str, session_id: str | None = Query(default=None)):
        require_paper(paper_id)
        with connect() as db:
            if session_id:
                rows = db.execute("SELECT * FROM research_tasks WHERE paper_id = ? AND session_id = ? ORDER BY created_at DESC", (paper_id, session_id)).fetchall()
            else:
                rows = db.execute("SELECT * FROM research_tasks WHERE paper_id = ? ORDER BY created_at DESC", (paper_id,)).fetchall()
            return {"tasks": [_task_view(db, row) for row in rows]}

    @router.post("/papers/{paper_id}/research", dependencies=[Depends(authorize)])
    async def create_task(paper_id: str, value: ResearchStartInput):
        paper = require_paper(paper_id)
        question = value.question.strip()
        if not question:
            raise HTTPException(status_code=422, detail="请输入研究问题。")
        if value.reasoning_effort not in ai.REASONING_EFFORTS:
            raise HTTPException(status_code=422, detail="研究推理强度无效。")
        if value.session_id:
            with connect() as db:
                session = db.execute("SELECT id FROM chat_sessions WHERE id = ? AND paper_id = ?", (value.session_id, paper_id)).fetchone()
            if not session:
                raise HTTPException(status_code=404, detail="找不到这段文献对话。")
        model, _config, _protocol = stream_config_for(value.model, paper)
        scope = _scope_for(value, paper)
        with connect() as db:
            _attach_expected_segments(db, paper_id, scope)
            task_id = uuid.uuid4().hex
            created = now()
            budget = {"model_calls": 0, "tool_calls": 0, "input_chars": 0, "image_bytes": 0,
                      "max_model_calls": MAX_MODEL_CALLS, "max_tool_calls": MAX_TOOL_CALLS,
                      "max_input_chars": MAX_INPUT_CHARS, "max_image_count": MAX_IMAGE_COUNT,
                      "max_image_bytes": MAX_TOTAL_IMAGE_BYTES, "max_task_seconds": MAX_TASK_SECONDS}
            steps = _plan(scope, supports_vision(model))
            db.execute(
                "INSERT INTO research_tasks(id, paper_id, session_id, question, model, reasoning_effort, scope_json, status, budget_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
                (task_id, paper_id, value.session_id, question, model, value.reasoning_effort, json.dumps(scope, ensure_ascii=False), json.dumps(budget), created, created),
            )
            for step in steps:
                db.execute("INSERT INTO research_steps(task_id, step_key, title, status, updated_at) VALUES (?, ?, ?, 'pending', ?)",
                           (task_id, step["key"], step["title"], created))
            _set_step(db, task_id, "scope", "running", "正在确认页码范围和可读取内容。")
            row = db.execute("SELECT * FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
            response = {"task": _task_view(db, row)}
        _start_worker(task_id)
        return response

    @router.get("/papers/{paper_id}/research/{task_id}", dependencies=[Depends(authorize)])
    def get_task(paper_id: str, task_id: str):
        require_paper(paper_id)
        with connect() as db:
            return {"task": _task_view(db, _get_task(db, paper_id, task_id))}

    @router.post("/papers/{paper_id}/research/{task_id}/stop", dependencies=[Depends(authorize)])
    async def stop_task(paper_id: str, task_id: str):
        require_paper(paper_id)
        with connect() as db:
            row = _get_task(db, paper_id, task_id)
            if row["status"] in {"completed", "failed", "stopped", "budget_exhausted"}:
                return {"task": _task_view(db, row)}
            db.execute("UPDATE research_tasks SET status = 'stopped', error = '用户已停止研究。', updated_at = ? WHERE id = ?", (now(), task_id))
            _set_step(db, task_id, "analysis", "stopped", "用户停止了研究任务。")
        active = ACTIVE_TASKS.get(task_id)
        pending_tasks = []
        if active and not active.done():
            active.cancel()
            pending_tasks.append(active)
        timeout_task = IMAGE_TIMEOUTS.pop(task_id, None)
        if timeout_task and not timeout_task.done():
            timeout_task.cancel()
            pending_tasks.append(timeout_task)
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)
        with connect() as db:
            return {"task": _task_view(db, _get_task(db, paper_id, task_id))}

    @router.post("/papers/{paper_id}/research/{task_id}/resume", dependencies=[Depends(authorize)])
    async def resume_task(paper_id: str, task_id: str):
        require_paper(paper_id)
        with connect() as db:
            _get_task(db, paper_id, task_id)
        active = ACTIVE_TASKS.get(task_id)
        if active and not active.done():
            await asyncio.gather(active, return_exceptions=True)
        with connect() as db:
            row = _get_task(db, paper_id, task_id)
            if row["status"] not in {"stopped", "failed", "interrupted", "waiting_for_image", "partial"}:
                raise HTTPException(status_code=409, detail="只有已停止、中断、失败或等待图像的任务可以继续。")
            pending_image_calls = _json(row["pending_image_calls_json"], [])
            next_status = "waiting_for_image" if pending_image_calls else "queued"
            db.execute("UPDATE research_tasks SET status = ?, error = '', updated_at = ? WHERE id = ?", (next_status, now(), task_id))
            _set_step(db, task_id, "analysis", "pending", "已从保存的证据与进度继续。")
        if pending_image_calls:
            timeout_task = IMAGE_TIMEOUTS.pop(task_id, None)
            if timeout_task and not timeout_task.done():
                timeout_task.cancel()
            if timeout_task:
                await asyncio.gather(timeout_task, return_exceptions=True)
            IMAGE_TIMEOUTS[task_id] = asyncio.create_task(_expire_image_wait(task_id, pending_image_calls, _start_worker))
        else:
            _start_worker(task_id)
        return {"task_id": task_id, "status": next_status}

    @router.post("/papers/{paper_id}/research/{task_id}/images/{request_id}", dependencies=[Depends(authorize)])
    async def receive_image(paper_id: str, task_id: str, request_id: str, value: ResearchImageInput):
        require_paper(paper_id)
        if value.mime_type not in {"image/jpeg", "image/png"}:
            raise HTTPException(status_code=422, detail="页面图像必须为 JPEG 或 PNG。")
        try:
            image = base64.b64decode(value.data_base64, validate=True)
        except (ValueError, binascii.Error):
            raise HTTPException(status_code=422, detail="页面图像编码无效。") from None
        if not image or len(image) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="页面图像不得超过2 MB。")
        valid_header = image.startswith(b"\xff\xd8\xff") if value.mime_type == "image/jpeg" else image.startswith(b"\x89PNG\r\n\x1a\n")
        if not valid_header:
            raise HTTPException(status_code=422, detail="页面图像格式与声明不一致。")
        with connect() as db:
            task_row = _get_task(db, paper_id, task_id)
            if task_row["status"] != "waiting_for_image":
                raise HTTPException(status_code=409, detail="这项任务当前没有等待页面图像。")
            request = db.execute("SELECT * FROM research_image_requests WHERE id = ? AND task_id = ?", (request_id, task_id)).fetchone()
            if not request:
                raise HTTPException(status_code=404, detail="找不到这条页面图像请求。")
            if request["status"] == "received":
                return {"status": "received"}
            if request["status"] != "pending":
                raise HTTPException(status_code=409, detail="页面图像请求已超时或已完成。")
            budget = _json(task_row["budget_json"], {})
            image_count = db.execute("SELECT count(*) AS count FROM research_image_requests WHERE task_id = ? AND status = 'received'", (task_id,)).fetchone()["count"]
            if image_count >= MAX_IMAGE_COUNT or budget.get("image_bytes", 0) + len(image) > MAX_TOTAL_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="本任务页面图像预算已用尽。")
            next_image = db.execute("SELECT count(*) AS count FROM research_evidence WHERE task_id = ? AND kind = 'image'", (task_id,)).fetchone()["count"] + 1
            source_id = f"I{next_image}"
            db.execute("UPDATE research_image_requests SET status = 'received', mime_type = ?, content = ?, evidence_source_id = ? WHERE id = ?",
                       (value.mime_type, image, source_id, request_id))
            budget["image_bytes"] = budget.get("image_bytes", 0) + len(image)
            db.execute("UPDATE research_tasks SET budget_json = ?, updated_at = ? WHERE id = ?", (json.dumps(budget), now(), task_id))
            _store_evidence(db, task_id, source_id, "image", f"原始 PDF 第 {request['page_no']} 页图像",
                            request["page_no"], request["page_no"], "", {"image_request_id": request_id, "verified_image_bytes": len(image)})
            pending = db.execute("SELECT count(*) AS count FROM research_image_requests WHERE task_id = ? AND status = 'pending'", (task_id,)).fetchone()["count"]
            if pending:
                return {"status": "received", "waiting_for_images": pending}
            db.execute("UPDATE research_tasks SET status = 'queued', error = '', updated_at = ? WHERE id = ?", (now(), task_id))
        timeout_task = IMAGE_TIMEOUTS.pop(task_id, None)
        if timeout_task and not timeout_task.done():
            timeout_task.cancel()
        _start_worker(task_id)
        return {"status": "received", "queued": True}

    app.include_router(router)
