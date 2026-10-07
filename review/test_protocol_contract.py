"""Responses API compatibility using local, isolated fixtures."""

import asyncio
import io
import json
import os
import sqlite3
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import httpx

from backend import ai
from backend.db import connect, initialize
from review.paths import REVIEW_ROOT


TOOL = [{
    "type": "function",
    "function": {
        "name": "read_paper",
        "description": "Read evidence",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    },
}]


def sse(*events):
    return b"".join(b"data: " + json.dumps(event, ensure_ascii=False).encode("utf-8") + b"\n\n" for event in events)


class ProtocolContract(unittest.TestCase):
    def test_legacy_settings_infer_chat_or_preserve_custom_protocol(self):
        root = REVIEW_ROOT
        for base_url, expected in (
            ("https://provider.example/v1", "openai_chat_completions"),
            ("https://provider.example/v1/chat/completions/", "openai_chat_completions"),
            ("https://provider.example/provider/custom/?route=paper%2Bnotes", "custom_chat_completions"),
        ):
            with self.subTest(base_url=base_url), tempfile.TemporaryDirectory(dir=root) as temporary, patch.dict(os.environ, {"WORKBENCH_DATA_DIR": temporary}):
                raw = sqlite3.connect(Path(temporary) / "workbench.sqlite")
                try:
                    raw.execute("CREATE TABLE settings(id INTEGER PRIMARY KEY, base_url TEXT NOT NULL, model TEXT NOT NULL, updated_at TEXT NOT NULL)")
                    raw.execute("INSERT INTO settings VALUES (1, ?, 'legacy-model', 'now')", (base_url,))
                    raw.commit()
                finally:
                    raw.close()
                initialize()
                with connect() as db:
                    row = db.execute("SELECT protocol, base_url, model FROM settings WHERE id=1").fetchone()
                self.assertEqual(row["protocol"], expected)
                self.assertEqual(row["base_url"], base_url)
                self.assertEqual(row["model"], "legacy-model")

    def test_endpoint_mapping_preserves_base_query_and_custom_url(self):
        self.assertEqual(
            ai.endpoint_for_protocol("https://provider.example/v1/?tenant=a%2Bb", "openai_chat_completions"),
            "https://provider.example/v1/chat/completions?tenant=a%2Bb",
        )
        self.assertEqual(
            ai.endpoint_for_protocol("https://provider.example/v1/chat/completions/?x=1", "openai_responses"),
            "https://provider.example/v1/responses/?x=1",
        )
        literal = "https://provider.example/custom/endpoint/?route=keep%2Bthis"
        self.assertEqual(ai.endpoint_for_protocol(literal, "custom_chat_completions"), literal)
        with self.assertRaises(ai.AIError):
            ai.endpoint_for_protocol(literal, "unknown")

    def test_sync_responses_tool_result_replays_raw_reasoning_and_usage(self):
        raw_output = [
            {"id": "rs_1", "type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}], "encrypted_content": "opaque-token"},
            {"id": "fc_1", "type": "function_call", "call_id": "call_1", "name": "read_paper", "arguments": '{"query":"样本"}'},
        ]
        tool_reply = {
            "id": "resp_1", "status": "completed", "output": raw_output,
            "usage": {"input_tokens": 20, "output_tokens": 5, "total_tokens": 25},
        }
        final_reply = {
            "id": "resp_2", "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "样本量为137。"}]}],
            "usage": {"input_tokens": 30, "output_tokens": 7, "total_tokens": 37},
        }
        sent = []

        def response(payload):
            return io.BytesIO(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

        def post(request, timeout):
            sent.append(request)
            return response(tool_reply if len(sent) == 1 else final_reply)

        with patch.object(ai, "current_config", return_value=("https://provider.example/v1", "default", "test-only-key")), \
             patch.object(ai, "_record_usage"), \
             patch.object(ai.urllib.request, "urlopen", side_effect=post):
            first = ai.chat_completion([{"role": "user", "content": "样本数"}], tools=TOOL, protocol="openai_responses")
            second = ai.chat_completion(
                [
                    {"role": "user", "content": "样本数"}, first["message"],
                    {"role": "tool", "tool_call_id": "call_1", "content": '{"status":"ok"}'},
                ],
                protocol="openai_responses",
            )

        self.assertEqual(sent[0].full_url, "https://provider.example/v1/responses")
        first_body = json.loads(sent[0].data)
        self.assertEqual(first_body["model"], "default")
        self.assertFalse(first_body["tools"][0]["strict"])
        self.assertEqual(first["reasoning"], "thinking")
        self.assertEqual(first["tool_calls"][0]["id"], "call_1")
        self.assertEqual(first["usage"]["total_tokens"], 25)
        self.assertEqual(second["content"], "样本量为137。")
        second_input = json.loads(sent[1].data)["input"]
        self.assertEqual(second_input[1:3], raw_output)
        self.assertEqual(second_input[3]["type"], "function_call_output")
        self.assertEqual(second_input[3]["call_id"], "call_1")

    def test_sync_responses_errors_keep_auth_and_incomplete_categories(self):
        failure = urllib.error.HTTPError(
            "https://provider.example/v1/responses", 401, "Unauthorized", {}, io.BytesIO(b'{"error":{"message":"bad key"}}')
        )
        with patch.object(ai, "current_config", return_value=("https://provider.example/v1", "m", "test-only-key")), \
             patch.object(ai.urllib.request, "urlopen", side_effect=failure), self.assertRaises(ai.AIError) as caught:
            ai.chat_completion([{"role": "user", "content": "hi"}], protocol="openai_responses")
        self.assertEqual(caught.exception.category, "authentication")
        failure.close()
        with self.assertRaises(ai.AIError) as caught:
            ai._parse_responses_payload({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}, tools=None, paper_id=None, operation="test")
        self.assertEqual(caught.exception.category, "incomplete_response")

    def test_responses_sse_streams_text_thoughts_and_usage(self):
        request_bodies = []
        response_payload = sse(
            {"type": "response.reasoning_summary_text.delta", "delta": "分析中"},
            {"type": "response.output_text.delta", "delta": "答案"},
            {"type": "response.completed", "response": {
                "status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "答案"}]}],
                "usage": {"input_tokens": 4, "output_tokens": 2, "total_tokens": 6},
            }},
        )

        def handler(request):
            request_bodies.append(json.loads(request.content))
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=response_payload)

        original_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return original_client(*args, **kwargs)

        async def run():
            with patch.object(ai, "current_config", return_value=("https://provider.example/v1", "m", "test-only-key")), \
                 patch.object(ai, "_record_usage"), patch.object(httpx, "AsyncClient", side_effect=client_factory):
                return [item async for item in ai.stream_chat_completion(
                    [{"role": "user", "content": "hi"}], protocol="openai_responses"
                )]

        result = asyncio.run(run())
        self.assertEqual([item["type"] for item in result], ["reasoning_delta", "content_delta", "result"])
        self.assertEqual(result[-1]["result"]["content"], "答案")
        self.assertEqual(result[-1]["result"]["reasoning"], "分析中")
        self.assertEqual(result[-1]["result"]["usage"]["total_tokens"], 6)
        self.assertEqual(request_bodies[0]["stream"], True)

    def test_responses_sse_tool_arguments_and_followup_keep_raw_output(self):
        raw = [
            {"id": "rs_2", "type": "reasoning", "summary": [{"type": "summary_text", "text": "查证"}], "encrypted_content": "keep"},
            {"id": "fc_2", "type": "function_call", "call_id": "call_2", "name": "read_paper", "arguments": '{"query":"样本"}'},
        ]
        payloads = [
            sse(
                {"type": "response.output_item.added", "output_index": 1, "item": {"type": "function_call", "id": "fc_2", "call_id": "call_2", "name": "read_paper", "arguments": ""}},
                {"type": "response.function_call_arguments.delta", "output_index": 1, "delta": '{"query":'},
                {"type": "response.function_call_arguments.delta", "output_index": 1, "delta": '"样本"}'},
                {"type": "response.output_item.done", "output_index": 1, "item": raw[1]},
                {"type": "response.completed", "response": {"status": "completed", "output": raw, "usage": {"input_tokens": 3, "output_tokens": 4, "total_tokens": 7}}},
            ),
            sse(
                {"type": "response.output_text.delta", "delta": "已找到。"},
                {"type": "response.completed", "response": {"status": "completed", "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "已找到。"}]}]}},
            ),
        ]
        sent = []

        def handler(request):
            sent.append(json.loads(request.content))
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payloads[len(sent) - 1])

        original_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return original_client(*args, **kwargs)

        async def run():
            with patch.object(ai, "current_config", return_value=("https://provider.example/v1", "m", "test-only-key")), \
                 patch.object(ai, "_record_usage"), patch.object(httpx, "AsyncClient", side_effect=client_factory):
                first = [item async for item in ai.stream_chat_completion(
                    [{"role": "user", "content": "样本数"}], tools=TOOL, protocol="openai_responses"
                )]
                message = first[-1]["result"]["message"]
                second = [item async for item in ai.stream_chat_completion(
                    [
                        {"role": "user", "content": "样本数"}, message,
                        {"role": "tool", "tool_call_id": "call_2", "content": '{"status":"ok"}'},
                    ], protocol="openai_responses"
                )]
                return first, second

        first, second = asyncio.run(run())
        self.assertEqual(first[-1]["result"]["tool_calls"][0]["function"]["arguments"], '{"query":"样本"}')
        self.assertEqual(second[-1]["result"]["content"], "已找到。")
        self.assertEqual(sent[1]["input"][1:3], raw)
        self.assertEqual(sent[1]["input"][3]["type"], "function_call_output")

    def test_responses_sse_top_level_error_and_incomplete_are_not_success(self):
        for event, category in (
            ({"type": "error", "code": "invalid_api_key", "message": "fixture rejected"}, "service_error"),
            ({"type": "response.incomplete", "response": {"incomplete_details": {"reason": "max_output_tokens"}}}, "context_length"),
        ):
            payload = sse(event)
            original_client = httpx.AsyncClient
            def client_factory(*args, **kwargs):
                kwargs["transport"] = httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payload))
                return original_client(*args, **kwargs)
            async def run():
                with patch.object(ai, "current_config", return_value=("https://provider.example/v1", "m", "test-only-key")), \
                     patch.object(httpx, "AsyncClient", side_effect=client_factory):
                    return [item async for item in ai.stream_chat_completion([{"role": "user", "content": "hi"}], protocol="openai_responses")]
            with self.subTest(event=event), self.assertRaises(ai.AIError) as caught:
                asyncio.run(run())
            self.assertEqual(caught.exception.category, category)

    def test_closing_responses_stream_closes_its_async_body(self):
        closed = asyncio.Event()
        started = asyncio.Event()

        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
                started.set()
                await asyncio.Event().wait()

            async def aclose(self):
                closed.set()

        original_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Body()))
            return original_client(*args, **kwargs)

        async def run():
            with patch.object(ai, "current_config", return_value=("https://provider.example/v1", "m", "test-only-key")), \
                 patch.object(httpx, "AsyncClient", side_effect=client_factory):
                stream = ai.stream_chat_completion([{"role": "user", "content": "hi"}], protocol="openai_responses")
                first = await anext(stream)
                await stream.aclose()
                await asyncio.wait_for(closed.wait(), 1)
                return first

        first = asyncio.run(run())
        self.assertEqual(first, {"type": "content_delta", "text": "partial"})


if __name__ == "__main__":
    unittest.main()
