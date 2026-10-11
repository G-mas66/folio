"""AI reasoning protocol request and response contracts."""

import asyncio
import io
import json
import unittest
import urllib.error
from unittest.mock import patch

import httpx

from backend import ai


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


class ReasoningProtocol(unittest.TestCase):

    def test_chat_completion_reasoning_controls_and_text_message(self):
        sent = []
        reply = {
            "choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": "答案", "reasoning_content": "服务提供的分析",
            }}],
        }

        def post(request, timeout):
            sent.append(json.loads(request.data))
            return io.BytesIO(json.dumps(reply, ensure_ascii=False).encode("utf-8"))

        with patch.object(ai, "_record_usage"), patch.object(ai.urllib.request, "urlopen", side_effect=post):
            default = ai.chat_completion(
                [{"role": "user", "content": "问题"}],
                config=("https://provider.example/v1", "model", "test-only-key"),
                protocol="openai_chat_completions",
            )
            explicit = ai.chat_completion(
                [{"role": "user", "content": "问题"}],
                config=("https://provider.example/v1", "model", "test-only-key"),
                protocol="openai_chat_completions", reasoning_effort="high",
            )
            deepseek = ai.chat_completion(
                [{"role": "user", "content": "问题"}],
                config=("https://api.deepseek.com/v1", "deepseek-flash", "test-only-key"),
                protocol="openai_chat_completions", thinking="enabled", reasoning_effort="medium",
            )

        self.assertNotIn("reasoning_effort", sent[0])
        self.assertNotIn("thinking", sent[0])
        self.assertEqual(sent[1]["reasoning_effort"], "high")
        self.assertEqual(sent[2]["thinking"], {"type": "enabled"})
        self.assertEqual(sent[2]["reasoning_effort"], "high")
        self.assertEqual(default["reasoning"], "服务提供的分析")
        self.assertEqual(default["message"]["reasoning_content"], "服务提供的分析")
        self.assertEqual(deepseek["message"]["reasoning_content"], "服务提供的分析")

    def test_chat_completion_keeps_reasoning_through_tool_and_text_turns(self):
        replies = [
            {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": None, "reasoning_content": "先检查原文", "tool_calls": [{
                    "id": "call_reasoning", "type": "function",
                    "function": {"name": "read_paper", "arguments": '{"query":"样本"}'},
                }],
            }}]},
            {"choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": "样本量是137。", "reasoning_content": "已核对工具结果",
            }}]},
        ]
        sent = []

        def post(request, timeout):
            sent.append(json.loads(request.data))
            return io.BytesIO(json.dumps(replies[len(sent) - 1], ensure_ascii=False).encode("utf-8"))

        with patch.object(ai, "_record_usage"), patch.object(ai.urllib.request, "urlopen", side_effect=post):
            first = ai.chat_completion(
                [{"role": "user", "content": "检查样本量"}], tools=TOOL,
                config=("https://provider.example/v1", "model", "test-only-key"),
                protocol="openai_chat_completions",
            )
            second = ai.chat_completion(
                [
                    {"role": "user", "content": "检查样本量"}, first["message"],
                    {"role": "tool", "tool_call_id": "call_reasoning", "content": "样本量为137"},
                ],
                config=("https://provider.example/v1", "model", "test-only-key"),
                protocol="openai_chat_completions",
            )

        self.assertEqual(first["message"]["reasoning_content"], "先检查原文")
        self.assertEqual(sent[1]["messages"][1]["reasoning_content"], "先检查原文")
        self.assertEqual(second["message"]["reasoning_content"], "已核对工具结果")
        self.assertEqual(second["content"], "样本量是137。")

    def test_deepseek_responses_effort_toggle_and_plain_reasoning(self):
        sent = []
        reply = {
            "status": "completed",
            "output": [
                {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "DeepSeek 思考"}], "summary": []},
                {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "答案"}]},
            ],
        }

        def post(request, timeout):
            sent.append(json.loads(request.data))
            return io.BytesIO(json.dumps(reply, ensure_ascii=False).encode("utf-8"))

        config = ("https://api.deepseek.com/v1", "deepseek-flash", "test-only-key")
        with patch.object(ai, "_record_usage"), patch.object(ai.urllib.request, "urlopen", side_effect=post):
            enabled = ai.chat_completion(
                [{"role": "user", "content": "问题"}], config=config,
                protocol="openai_responses", thinking="enabled",
            )
            minimal = ai.chat_completion(
                [{"role": "user", "content": "问题"}], config=config,
                protocol="openai_responses", reasoning_effort="minimal",
            )
            disabled = ai.chat_completion(
                [{"role": "user", "content": "问题"}], config=config,
                protocol="openai_responses", thinking="disabled",
            )

        self.assertEqual(sent[0]["reasoning"], {"effort": "high"})
        self.assertEqual(sent[1]["reasoning"], {"effort": "low"})
        self.assertEqual(sent[2]["reasoning"], {"effort": "none"})
        self.assertEqual(enabled["reasoning"], "DeepSeek 思考")
        self.assertEqual(enabled["message"]["reasoning_content"], "DeepSeek 思考")
        self.assertEqual(enabled["message"]["_responses_output"], reply["output"])

    def test_openai_responses_controls_and_known_unsupported_effort(self):
        request_bodies = []
        response = {
            "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "答案"}]}],
        }

        def post(request, timeout):
            request_bodies.append(json.loads(request.data))
            return io.BytesIO(json.dumps(response, ensure_ascii=False).encode("utf-8"))

        with patch.object(ai, "_record_usage"), patch.object(ai.urllib.request, "urlopen", side_effect=post):
            ai.chat_completion(
                [{"role": "user", "content": "问题"}],
                config=("https://provider.example/v1", "model", "test-only-key"),
                protocol="openai_responses", thinking="enabled", reasoning_effort="high",
            )
            ai.chat_completion(
                [{"role": "user", "content": "问题"}],
                config=("https://api.openai.com/v1", "gpt-6-luna", "test-only-key"),
                protocol="openai_responses", thinking="disabled",
            )
            ai.chat_completion(
                [{"role": "user", "content": "问题"}],
                config=("https://gateway.example/v1", "gpt-6-astra", "test-only-key"),
                protocol="openai_responses", thinking="disabled",
            )

        self.assertEqual(request_bodies[0]["reasoning"], {"summary": "auto", "effort": "high"})
        self.assertEqual(request_bodies[1]["reasoning"], {"effort": "none"})
        self.assertEqual(request_bodies[2]["reasoning"], {"effort": "none"})
        for model in ("gpt-6-astra", "gpt-6.1-sol"):
            with self.subTest(model=model), patch.object(ai.urllib.request, "urlopen") as post, self.assertRaises(ai.AIError) as caught:
                ai.chat_completion(
                    [{"role": "user", "content": "问题"}],
                    config=("https://api.openai.com/v1", model, "test-only-key"),
                    protocol="openai_responses", thinking="disabled",
                )
            self.assertEqual(caught.exception.category, "unsupported_reasoning")
            post.assert_not_called()
        with self.assertRaises(ai.AIError) as caught:
            ai.chat_completion(
                [{"role": "user", "content": "问题"}],
                config=("https://api.openai.com/v1", "gpt-6-astra", "test-only-key"),
                protocol="openai_responses", reasoning_effort="minimal",
            )
        self.assertEqual(caught.exception.category, "unsupported_reasoning")

    def test_openai_responses_stream_reasoning_controls(self):
        payload = sse(
            {"type": "response.reasoning_summary_text.delta", "delta": "OpenAI summary"},
            {"type": "response.output_text.delta", "delta": "Answer"},
            {"type": "response.completed", "response": {
                "status": "completed",
                "output": [
                    {"type": "reasoning", "summary": [{"type": "summary_text", "text": "OpenAI summary"}]},
                    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Answer"}]},
                ],
            }},
        )
        request_bodies = []

        def handler(request):
            request_bodies.append(json.loads(request.content))
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payload)

        original_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return original_client(*args, **kwargs)

        async def run():
            with patch.object(ai, "current_config", return_value=("https://provider.example/v1", "model", "test-only-key")), \
                 patch.object(ai, "_record_usage"), patch.object(httpx, "AsyncClient", side_effect=client_factory):
                return [item async for item in ai.stream_chat_completion(
                    [{"role": "user", "content": "Question"}], protocol="openai_responses",
                    thinking="enabled", reasoning_effort="high",
                )]

        result = asyncio.run(run())
        self.assertEqual(request_bodies[0]["reasoning"], {"summary": "auto", "effort": "high"})
        self.assertEqual(result[-1]["result"]["reasoning"], "OpenAI summary")
        self.assertEqual(result[-1]["result"]["message"]["reasoning_content"], "OpenAI summary")

    def test_deepseek_responses_stream_reasoning_text(self):
        raw_output = [
            {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "DeepSeek stream thought"}], "summary": []},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Answer"}]},
        ]
        payload = sse(
            {"type": "response.reasoning_text.delta", "delta": "DeepSeek stream thought"},
            {"type": "response.output_text.delta", "delta": "Answer"},
            {"type": "response.completed", "response": {"status": "completed", "output": raw_output}},
        )
        request_bodies = []

        def handler(request):
            request_bodies.append(json.loads(request.content))
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payload)

        original_client = httpx.AsyncClient

        def client_factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return original_client(*args, **kwargs)

        async def run():
            with patch.object(ai, "current_config", return_value=("https://api.deepseek.com/v1", "deepseek-flash", "test-only-key")), \
                 patch.object(ai, "_record_usage"), patch.object(httpx, "AsyncClient", side_effect=client_factory):
                return [item async for item in ai.stream_chat_completion(
                    [{"role": "user", "content": "Question"}], protocol="openai_responses",
                    thinking="enabled",
                )]

        result = asyncio.run(run())
        self.assertEqual(request_bodies[0]["reasoning"], {"effort": "high"})
        self.assertEqual(result[-1]["result"]["reasoning"], "DeepSeek stream thought")
        self.assertEqual(result[-1]["result"]["message"]["reasoning_content"], "DeepSeek stream thought")
        self.assertEqual(result[-1]["result"]["message"]["_responses_output"], raw_output)

    def test_explicit_reasoning_http_error_keeps_provider_message(self):
        failure = urllib.error.HTTPError(
            "https://provider.example/v1/chat/completions", 400, "Bad Request", {},
            io.BytesIO(b'{"error":{"message":"reasoning_effort is not supported"}}'),
        )
        with patch.object(ai.urllib.request, "urlopen", side_effect=failure) as post, self.assertRaises(ai.AIError) as caught:
            ai.chat_completion(
                [{"role": "user", "content": "问题"}], tools=TOOL,
                config=("https://provider.example/v1", "model", "test-only-key"),
                protocol="openai_chat_completions", reasoning_effort="high",
            )
        self.assertEqual(caught.exception.category, "service_error")
        self.assertIn("HTTP 400", caught.exception.message)
        self.assertIn("reasoning_effort is not supported", caught.exception.message)
        post.assert_called_once()
        failure.close()

    def test_chat_completion_stream_preserves_reasoning_for_text_and_tools(self):
        payloads = [
            sse({"choices": [{"delta": {"reasoning_content": "文本分析", "content": "答案"}, "finish_reason": "stop"}]}) + b"data: [DONE]\n\n",
            sse(
                {"choices": [{"delta": {"reasoning_content": "工具分析", "tool_calls": [{
                    "index": 0, "id": "call_stream", "type": "function",
                    "function": {"name": "read_paper", "arguments": '{"query":"样本"}'},
                }]}, "finish_reason": None}]},
                {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
            ) + b"data: [DONE]\n\n",
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
            with patch.object(ai, "current_config", return_value=("https://provider.example/v1", "model", "test-only-key")), \
                 patch.object(ai, "_record_usage"), patch.object(httpx, "AsyncClient", side_effect=client_factory):
                text = [item async for item in ai.stream_chat_completion(
                    [{"role": "user", "content": "问题"}], protocol="openai_chat_completions"
                )]
                tool = [item async for item in ai.stream_chat_completion(
                    [{"role": "user", "content": "问题"}], tools=TOOL,
                    protocol="openai_chat_completions", reasoning_effort="high",
                )]
                return text, tool

        text, tool = asyncio.run(run())
        self.assertNotIn("reasoning_effort", sent[0])
        self.assertEqual(sent[1]["reasoning_effort"], "high")
        self.assertEqual(text[-1]["result"]["message"]["reasoning_content"], "文本分析")
        self.assertEqual(tool[-1]["result"]["message"]["reasoning_content"], "工具分析")
        self.assertEqual(tool[-1]["result"]["tool_calls"][0]["id"], "call_stream")

if __name__ == "__main__":
    unittest.main()
