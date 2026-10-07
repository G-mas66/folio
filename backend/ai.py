from __future__ import annotations

import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, AsyncIterator

from .db import connect, data_root


@dataclass
class AIError(Exception):
    category: str
    message: str

    def __str__(self) -> str:
        return self.message


def credential_service() -> str:
    import keyring

    if os.name == "nt":
        from keyring.backends.Windows import WinVaultKeyring

        backend = keyring.get_keyring()
        if not isinstance(backend, WinVaultKeyring):
            keyring.set_keyring(WinVaultKeyring())
    identity_root = os.environ.get("WORKBENCH_CREDENTIAL_ROOT") or str(data_root())
    namespace = hashlib.sha256(os.path.abspath(identity_root).casefold().encode("utf-8")).hexdigest()[:16]
    return f"personal-paper-workbench-{namespace}"


def key_is_configured() -> bool:
    try:
        import keyring

        return bool(keyring.get_password(credential_service(), "api-key"))
    except Exception:
        return False


def save_api_key(api_key: str) -> None:
    import keyring

    keyring.set_password(credential_service(), "api-key", api_key)


def saved_api_key() -> str:
    import keyring

    try:
        return keyring.get_password(credential_service(), "api-key") or ""
    except Exception as exc:
        raise AIError("credential_store", "无法读取 Windows 凭据管理器中的 API Key。") from exc


def current_config() -> tuple[str, str, str]:
    with connect() as db:
        row = db.execute("SELECT base_url, model FROM settings WHERE id = 1").fetchone()
    if not row:
        raise AIError("not_configured", "请先配置 AI 服务地址和模型。")
    password = saved_api_key()
    if not password:
        raise AIError("not_configured", "请先配置 API Key。")
    return normalize_base_url(row["base_url"]), row["model"], password


def normalize_base_url(base_url: str) -> str:
    value = base_url.strip()
    if not value.lower().startswith(("http://", "https://")):
        raise AIError("invalid_address", "服务地址必须以 http:// 或 https:// 开头。")
    return value


def _record_usage(paper_id: str | None, operation: str, usage: object) -> None:
    if not isinstance(usage, dict):
        return

    def count(field: str) -> int | None:
        value = usage.get(field)
        return value if isinstance(value, int) and value >= 0 else None

    values = (count("prompt_tokens"), count("completion_tokens"), count("total_tokens"))
    if not any(value is not None for value in values):
        return
    with connect() as db:
        db.execute(
            "INSERT INTO api_usage(paper_id, operation, prompt_tokens, completion_tokens, total_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (paper_id, operation, *values, datetime.now(timezone.utc).isoformat()),
        )


def chat_completion(
    messages: list[dict[str, Any]], *, operation: str = "chat", paper_id: str | None = None,
    timeout: int = 90, tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None, model: str | None = None,
) -> dict[str, Any]:
    base_url, configured_model, api_key = current_config()
    selected_model = (model or configured_model).strip()
    if not selected_model:
        raise AIError("not_configured", "请配置要使用的模型名称。")
    request_body: dict[str, Any] = {"model": selected_model, "messages": messages, "stream": False}
    if tools:
        request_body["tools"] = tools
        request_body["tool_choice"] = tool_choice or "auto"
    body = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        base_url,
        data=body,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        status = exc.code
        context_error = status == 413
        if status in {400, 422}:
            try:
                error_payload = json.loads(exc.read().decode("utf-8"))
                details = error_payload.get("error", {}) if isinstance(error_payload, dict) else {}
                if not isinstance(details, dict):
                    details = {}
                codes = {details.get("code"), details.get("type")}
                context_error = any(
                    isinstance(code, str) and code.casefold() in {"context_length_exceeded", "input_too_long", "max_tokens"}
                    for code in codes
                )
            except (json.JSONDecodeError, UnicodeDecodeError, OSError):
                context_error = False
        if context_error:
            raise AIError(
                "context_length",
                "AI 服务拒绝了完整原文请求，输入超出或超过模型容量；本次没有截断或分块，请检查所选模型和服务的输入上限。",
            ) from None
        if tools and status in {400, 422}:
            raise AIError(
                "tools_unsupported",
                f"AI 服务返回 HTTP {status}；可能不支持工具调用，也可能模型或请求参数有误。请检查服务商对 tools 的支持及模型配置。",
            ) from None
        category = {
            401: "authentication",
            403: "authentication",
            404: "model_or_address",
            429: "rate_limit",
        }.get(status, "service_error")
        message = {
            "authentication": "API Key 无效或没有权限，请检查凭据。",
            "model_or_address": "模型或服务地址不可用，请检查配置。",
            "rate_limit": "服务暂时限流或额度不足，请稍后重试。",
            "service_error": f"AI 服务返回 HTTP {status}。",
        }[category]
        raise AIError(category, message) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise AIError("network", "无法连接 AI 服务，请检查地址和网络。") from None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise AIError("invalid_response", "AI 服务返回的内容不是有效 JSON。") from None

    choices = payload.get("choices") if isinstance(payload, dict) else None
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise AIError("invalid_response", "AI 服务没有返回可用的回答。")
    choice = choices[0]
    reason = choice.get("finish_reason")
    message = choice.get("message")
    raw_calls = message.get("tool_calls") if isinstance(message, dict) else None
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if reason == "tool_calls":
        if not tools:
            raise AIError("incomplete_response", "服务返回了工具调用，但本轮没有启用文献工具。")
        if not isinstance(raw_calls, list) or not raw_calls:
            raise AIError("invalid_response", "AI 服务声明了工具调用，但没有返回有效调用。")
        if any(
            not isinstance(call, dict)
            or not isinstance(call.get("id"), str)
            or not isinstance(call.get("function"), dict)
            or not isinstance(call["function"].get("name"), str)
            or not isinstance(call["function"].get("arguments"), str)
            for call in raw_calls
        ):
            raise AIError("invalid_response", "AI 服务返回了格式无效的工具调用。")
        _record_usage(paper_id, operation, usage)
        return {
            "content": message.get("content") if isinstance(message.get("content"), str) else "",
            "tool_calls": raw_calls,
            "message": {"role": "assistant", "content": message.get("content"), "tool_calls": raw_calls},
            "usage": usage if isinstance(usage, dict) else None,
        }
    if raw_calls:
        raise AIError("invalid_response", "AI 服务在未声明工具调用时返回了工具请求。")
    if reason != "stop":
        reason_text = {
            "length": "回答达到长度上限，内容未完成。",
            "content_filter": "回答被服务的内容过滤器截断。",
            "tool_calls": "服务返回了工具调用而非完整文本。",
            None: "服务没有说明回答是否正常结束。",
        }.get(reason, "AI 回答未正常结束。")
        raise AIError("incomplete_response", reason_text)
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise AIError("empty_response", "AI 服务返回了空内容。")
    _record_usage(paper_id, operation, usage)
    return {"content": content.strip(), "usage": usage if isinstance(usage, dict) else None}


async def stream_chat_completion(
    messages: list[dict[str, Any]], *, operation: str = "chat", paper_id: str | None = None,
    timeout: int = 90, tools: list[dict[str, Any]] | None = None,
    tool_choice: str | dict[str, Any] | None = None, model: str | None = None,
    config: tuple[str, str, str] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    import httpx

    base_url, configured_model, api_key = config or current_config()
    selected_model = (model or configured_model).strip()
    if not selected_model:
        raise AIError("not_configured", "请配置要使用的模型名称。")
    request_body: dict[str, Any] = {"model": selected_model, "messages": messages, "stream": True}
    if tools:
        request_body["tools"] = tools
        request_body["tool_choice"] = tool_choice or "auto"

    def status_error(status: int, body: bytes) -> AIError:
        context_error = status == 413
        if status in {400, 422}:
            try:
                payload = json.loads(body.decode("utf-8"))
                details = payload.get("error", {}) if isinstance(payload, dict) else {}
                codes = {details.get("code"), details.get("type")} if isinstance(details, dict) else set()
                context_error = any(
                    isinstance(code, str) and code.casefold() in {"context_length_exceeded", "input_too_long", "max_tokens"}
                    for code in codes
                )
            except (json.JSONDecodeError, UnicodeDecodeError):
                context_error = False
        if context_error:
            return AIError("context_length", "AI 服务拒绝了完整原文请求，输入超出或超过模型容量；本次没有截断或分块，请检查所选模型和服务的输入上限。")
        if tools and status in {400, 422}:
            return AIError("tools_unsupported", f"AI 服务返回 HTTP {status}；可能不支持工具调用，也可能模型或请求参数有误。请检查服务商对 tools 的支持及模型配置。")
        category = {401: "authentication", 403: "authentication", 404: "model_or_address", 429: "rate_limit"}.get(status, "service_error")
        message = {
            "authentication": "API Key 无效或没有权限，请检查凭据。",
            "model_or_address": "模型或服务地址不可用，请检查配置。",
            "rate_limit": "服务暂时限流或额度不足，请稍后重试。",
            "service_error": f"AI 服务返回 HTTP {status}。",
        }[category]
        return AIError(category, message)

    request_body_bytes = json.dumps(request_body, ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "Accept": "text/event-stream"}
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    calls: dict[int, dict[str, Any]] = {}
    finish_reason: str | None = None
    usage: dict[str, Any] | None = None
    saw_done = False
    in_think = False
    content_buffer = ""
    think_open = "<think>"
    think_close = "</think>"

    def consume_content(text: str, final: bool = False) -> list[dict[str, str]]:
        nonlocal content_buffer, in_think
        content_buffer += text
        output: list[dict[str, str]] = []
        while content_buffer:
            marker = think_close if in_think else think_open
            found = content_buffer.find(marker)
            if found >= 0:
                value = content_buffer[:found]
                if value:
                    output.append({"type": "reasoning_delta" if in_think else "content_delta", "text": value})
                    (reasoning_parts if in_think else content_parts).append(value)
                content_buffer = content_buffer[found + len(marker):]
                in_think = not in_think
                continue
            if final:
                if content_buffer:
                    output.append({"type": "reasoning_delta" if in_think else "content_delta", "text": content_buffer})
                    (reasoning_parts if in_think else content_parts).append(content_buffer)
                content_buffer = ""
                break
            keep = 0
            for length in range(min(len(marker) - 1, len(content_buffer)), 0, -1):
                if content_buffer.endswith(marker[:length]):
                    keep = length
                    break
            safe_length = len(content_buffer) - keep
            if safe_length:
                value, content_buffer = content_buffer[:safe_length], content_buffer[safe_length:]
                output.append({"type": "reasoning_delta" if in_think else "content_delta", "text": value})
                (reasoning_parts if in_think else content_parts).append(value)
            break
        return output

    def consume_data(raw: str) -> list[dict[str, str]]:
        nonlocal finish_reason, usage
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            raise AIError("invalid_response", "AI 服务返回了无效的流式数据。") from None
        if not isinstance(payload, dict):
            raise AIError("invalid_response", "AI 服务返回了无效的流式数据。")
        if isinstance(payload.get("usage"), dict):
            usage = payload["usage"]
        choices = payload.get("choices", [])
        if not isinstance(choices, list):
            raise AIError("invalid_response", "AI 服务返回了无效的流式选项。")
        emitted: list[dict[str, str]] = []
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            reason = choice.get("finish_reason")
            if reason is not None:
                finish_reason = reason
            delta = choice.get("delta")
            if not isinstance(delta, dict):
                continue
            for key in ("reasoning_content", "reasoning"):
                value = delta.get(key)
                if isinstance(value, str) and value:
                    reasoning_parts.append(value)
                    emitted.append({"type": "reasoning_delta", "text": value})
            value = delta.get("content")
            if isinstance(value, str) and value:
                emitted.extend(consume_content(value))
            fragments = delta.get("tool_calls")
            if fragments is not None:
                if not isinstance(fragments, list):
                    raise AIError("invalid_response", "AI 服务返回了格式无效的工具请求。")
                for fragment in fragments:
                    if not isinstance(fragment, dict) or type(fragment.get("index")) is not int or fragment["index"] < 0:
                        raise AIError("invalid_response", "AI 服务返回了格式无效的工具请求。")
                    index = fragment["index"]
                    call = calls.setdefault(index, {"index": index, "id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    if isinstance(fragment.get("id"), str):
                        call["id"] += fragment["id"]
                    function = fragment.get("function")
                    if isinstance(function, dict):
                        if isinstance(function.get("name"), str):
                            call["function"]["name"] += function["name"]
                        if isinstance(function.get("arguments"), str):
                            call["function"]["arguments"] += function["arguments"]
        return emitted

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout), follow_redirects=False) as client:
            async with client.stream("POST", base_url, content=request_body_bytes, headers=headers) as response:
                if response.status_code >= 400:
                    body = await response.aread()
                    raise status_error(response.status_code, body)
                data_lines: list[str] = []
                async for line in response.aiter_lines():
                    if line == "":
                        if not data_lines:
                            continue
                        data = "\n".join(data_lines)
                        data_lines.clear()
                        if data.strip() == "[DONE]":
                            saw_done = True
                            break
                        for event in consume_data(data):
                            yield event
                    elif line.startswith("data:"):
                        data_lines.append(line[5:].lstrip())
                if data_lines and not saw_done:
                    data = "\n".join(data_lines)
                    if data.strip() == "[DONE]":
                        saw_done = True
                    else:
                        for event in consume_data(data):
                            yield event
    except AIError:
        raise
    except httpx.TimeoutException:
        raise AIError("network", "AI 服务连接超时，请检查网络后重试。") from None
    except httpx.HTTPError:
        raise AIError("network", "无法连接 AI 服务，请检查地址和网络。") from None

    for event in consume_content("", final=True):
        yield event
    if in_think:
        raise AIError("incomplete_response", "AI 服务返回的思考内容未正常结束。")
    if not saw_done:
        raise AIError("incomplete_response", "AI 流式响应未正常结束。")
    if finish_reason not in {"stop", "tool_calls"}:
        reason_text = {
            "length": "回答达到长度上限，内容未完成。",
            "content_filter": "回答被服务的内容过滤器截断。",
            None: "服务没有说明回答是否正常结束。",
        }.get(finish_reason, "AI 回答未正常结束。")
        raise AIError("incomplete_response", reason_text)
    if finish_reason == "tool_calls":
        raw_calls = [
            {key: value for key, value in calls[index].items() if key != "index"}
            for index in sorted(calls)
        ]
        if not tools or not raw_calls or any(
            not call["id"] or not call["function"]["name"] or not call["function"]["arguments"]
            for call in raw_calls
        ):
            raise AIError("invalid_response", "AI 服务声明了工具调用，但没有返回有效调用。")
        message: dict[str, Any] = {"role": "assistant", "content": "".join(content_parts) or None, "tool_calls": raw_calls}
        reasoning = "".join(reasoning_parts)
        if reasoning:
            message["reasoning_content"] = reasoning
        _record_usage(paper_id, operation, usage)
        yield {
            "type": "result",
            "result": {"content": "".join(content_parts), "reasoning": reasoning, "tool_calls": raw_calls, "message": message, "usage": usage},
        }
        return
    if calls:
        raise AIError("invalid_response", "AI 服务在未声明工具调用时返回了工具请求。")
    content = "".join(content_parts)
    if not content.strip():
        raise AIError("empty_response", "AI 服务返回了空内容。")
    _record_usage(paper_id, operation, usage)
    yield {"type": "result", "result": {"content": content.strip(), "reasoning": "".join(reasoning_parts), "usage": usage}}


def _translation_and_terms(content: str, source: str) -> tuple[str, list[tuple[str, str]]]:
    marker = "<WORKBENCH_GLOSSARY>"
    if marker not in content:
        return content.strip(), []
    translation, raw_terms = content.rsplit(marker, 1)
    source_folded = source.casefold()
    translation_folded = translation.casefold()
    entries: list[tuple[str, str]] = []
    for line in raw_terms.splitlines():
        if "\t" not in line:
            continue
        term, translated = (part.strip() for part in line.split("\t", 1))
        if (term and translated and len(term) <= 80 and len(translated) <= 80
                and term.casefold() in source_folded and translated.casefold() in translation_folded):
            entries.append((term, translated))
        if len(entries) == 12:
            break
    return translation.strip(), entries


def translate_text(text: str, *, context: str = "", paper_id: str | None = None) -> str:
    collect_terms = context.startswith("论文：")
    glossary: list[tuple[str, str]] = []
    if collect_terms and paper_id:
        with connect() as db:
            glossary = [
                (row["term"], row["translation"])
                for row in db.execute(
                    "SELECT term, translation FROM paper_glossary WHERE paper_id = ? ORDER BY term LIMIT 120",
                    (paper_id,),
                )
            ]
    term_context = context
    if glossary:
        term_context += "\n本篇术语表（请保持以下译法）：\n" + "；".join(
            f"{term} → {translated}" for term, translated in glossary
        )
    instructions = (
        "你是学术论文英译中译者。将用户给出的所有英文内容完整翻译为简体中文；"
        "只输出译文，不作总结或删节。保留作者和机构名称、期刊名、DOI、参考文献编号、"
        "公式、数字、单位及原有引用标记；不得改变数值。"
    )
    if collect_terms:
        instructions += (
            "译文末尾另起一行输出 <WORKBENCH_GLOSSARY>，其后每行按“原文术语<TAB>中文译法”"
            "列出本段新出现的至多 12 个专业术语；不要把术语表写进译文正文，没有新术语时只输出标记。"
        )
    result = chat_completion(
        [
            {"role": "system", "content": instructions},
            {"role": "user", "content": (f"术语与上下文：\n{term_context}\n\n" if term_context else "") + text},
        ],
        operation="translation",
        paper_id=paper_id,
    )
    translation, terms = _translation_and_terms(result["content"], text) if collect_terms else (result["content"], [])
    if not translation.strip():
        raise AIError("empty_response", "AI 服务返回了空译文。")
    if paper_id and terms:
        with connect() as db:
            db.executemany(
                "INSERT INTO paper_glossary(paper_id, term, translation) VALUES (?, ?, ?) "
                "ON CONFLICT(paper_id, term) DO NOTHING",
                [(paper_id, term, translated) for term, translated in terms],
            )
    return translation


def validate_sources(answer: str, allowed: dict[str, dict[str, int]]) -> tuple[str, list[dict[str, int | str]]]:
    referenced: list[dict[str, int | str]] = []
    seen: set[str] = set()

    def replace(match: re.Match[str]) -> str:
        source_id = match.group(1)
        source = allowed.get(source_id)
        if source is None:
            return "〔未验证来源〕"
        if source_id not in seen:
            seen.add(source_id)
            referenced.append({"id": source_id, "start_page": source["start_page"], "end_page": source["end_page"]})
        return f"[{source_id}]"

    sanitized = re.sub(r"\[(S\d{1,10})\]", replace, answer)
    return sanitized, referenced
