"""Independent review of completion and citation failure boundaries."""

import io
import json
import threading
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from backend import ai


class APIContractReview(unittest.TestCase):
    def completion(self, payload, **kwargs):
        response = io.BytesIO(json.dumps(payload).encode("utf-8"))
        with patch.object(ai, "current_config", return_value=(
            "http://127.0.0.1:9999/v1/chat/completions", "fixture", "review-only-key"
        )), patch.object(ai.urllib.request, "urlopen", return_value=response):
            return ai.chat_completion([{"role": "user", "content": "review"}], **kwargs)

    def test_configured_url_does_not_gain_an_endpoint_path(self):
        for address in (
            "https://provider.example",
            "https://provider.example/v1",
            "https://provider.example/v1/",
            "https://provider.example/custom/chat/completions",
            "https://provider.example/custom/request/?route=paper%2Bnotes",
        ):
            with self.subTest(address=address):
                self.assertEqual(ai.normalize_base_url(address), address)

    def test_configured_url_only_trims_surrounding_whitespace(self):
        self.assertEqual(
            ai.normalize_base_url("  https://provider.example/custom/request/  "),
            "https://provider.example/custom/request/",
        )

    def test_missing_usage_does_not_block_text(self):
        result = self.completion({"choices": [{
            "finish_reason": "stop", "message": {"content": "complete answer"}
        }]})
        self.assertEqual(result["content"], "complete answer")
        self.assertIsNone(result["usage"])

    def test_truncated_or_filtered_output_is_not_success(self):
        for reason in ("length", "content_filter", "tool_calls", None):
            with self.subTest(reason=reason), self.assertRaises(ai.AIError) as caught:
                self.completion({"choices": [{
                    "finish_reason": reason, "message": {"content": "partial answer"}
                }]})
            self.assertEqual(caught.exception.category, "incomplete_response")

    def test_empty_or_malformed_answer_is_not_success(self):
        for payload in (
            {"choices": []},
            {"choices": [{"finish_reason": "stop", "message": {"content": " "}}]},
            {"choices": [{"finish_reason": "stop", "message": {"content": None}}]},
        ):
            with self.subTest(payload=payload), self.assertRaises(ai.AIError):
                self.completion(payload)

    def test_unknown_source_is_not_clickable_and_terms_are_preserved(self):
        answer, sources = ai.validate_sources(
            "The [DNA] measurement is documented [S1]. Unsupported [S999].",
            {"S1": {"start_page": 2, "end_page": 3}},
        )
        self.assertIn("[DNA]", answer)
        self.assertEqual([source["id"] for source in sources], ["S1"])
        self.assertNotIn("[S999]", answer)

    def test_tool_call_roundtrip_uses_literal_url_and_selected_model(self):
        tool = {'type': 'function', 'function': {'name': 'read_paper', 'description': 'Read current paper', 'parameters': {'type': 'object', 'properties': {'query': {'type': 'string'}}}}}
        call = {'id': 'call_1', 'type': 'function', 'function': {'name': 'read_paper', 'arguments': '{"query":"samples"}'}}
        response = io.BytesIO(json.dumps({'choices': [{'finish_reason': 'tool_calls', 'message': {'role': 'assistant', 'content': None, 'tool_calls': [call]}}]}).encode())
        address = 'http://127.0.0.1:9999/provider/custom/?route=paper%2Bnotes'
        with patch.object(ai, 'current_config', return_value=(address, 'default-model', 'review-only-key')), patch.object(ai.urllib.request, 'urlopen', return_value=response) as request:
            result = ai.chat_completion([{'role': 'user', 'content': '样本多少'}], tools=[tool], model='selected-model')
        sent = request.call_args.args[0]
        body = json.loads(sent.data)
        self.assertEqual(sent.full_url, address)
        self.assertEqual(body['model'], 'selected-model')
        self.assertEqual(body['tool_choice'], 'auto')
        self.assertEqual(body['tools'], [tool])
        self.assertEqual(result['tool_calls'], [call])
        self.assertEqual(sent.get_header('Authorization'), 'Bearer review-only-key')
        self.assertEqual(sent.get_header('User-agent'), ai.API_USER_AGENT)

    def test_chat_completion_passes_a_gateway_that_rejects_python_user_agents(self):
        requests = []

        class Provider(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path, self.headers.get('Authorization'), self.headers.get('User-Agent')))
                self.rfile.read(int(self.headers.get('Content-Length', '0')))
                if self.headers.get('User-Agent') != ai.API_USER_AGENT:
                    status = 403
                    payload = {'error': {'message': 'browser signature blocked'}}
                else:
                    status = 200
                    payload = {'choices': [{'finish_reason': 'stop', 'message': {'content': 'ok'}}]}
                body = json.dumps(payload).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = ai.chat_completion(
                [{'role': 'user', 'content': 'synthetic test'}],
                config=(f'http://127.0.0.1:{server.server_port}/v1', 'fixture', 'review-only-key'),
                protocol='openai_chat_completions',
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(result['content'], 'ok')
        self.assertEqual(requests, [('/v1/chat/completions', 'Bearer review-only-key', ai.API_USER_AGENT)])

    def test_malformed_tool_calls_and_truncated_calls_cannot_execute(self):
        tools = [{'type': 'function', 'function': {'name': 'read_paper', 'parameters': {'type': 'object', 'properties': {}}}}]
        for reason, calls in (
            ('tool_calls', []),
            ('tool_calls', [{'id': 'bad', 'type': 'function', 'function': {'name': 'read_paper', 'arguments': None}}]),
            ('length', [{'id': 'cut', 'type': 'function', 'function': {'name': 'read_paper', 'arguments': '{'}}]),
        ):
            with self.subTest(reason=reason, calls=calls), self.assertRaises(ai.AIError):
                self.completion({'choices': [{'finish_reason': reason, 'message': {'content': None, 'tool_calls': calls}}]}, tools=tools)

    def test_input_capacity_errors_remain_distinct_from_authentication_and_tools(self):
        for status, body, expected in [
            (413,{},'context_length'),
            (400,{'error':{'code':'context_length_exceeded'}},'context_length'),
            (422,{'error':{'type':'input_too_long'}},'context_length'),
            (401,{},'authentication'),
            (400,{'error':{'code':'invalid_parameter'}},'tools_unsupported'),
        ]:
            failure = urllib.error.HTTPError('http://127.0.0.1:9999/literal/', status, 'fixture', {}, io.BytesIO(json.dumps(body).encode()))
            with self.subTest(status=status,body=body), patch.object(ai,'current_config',return_value=('http://127.0.0.1:9999/literal/','mimo-v6pro','review-only-key')), patch.object(ai.urllib.request,'urlopen',side_effect=failure), self.assertRaises(ai.AIError) as caught:
                ai.chat_completion([{'role':'user','content':'完整正文'}],tools=[{'type':'function','function':{'name':'read_paper','parameters':{'type':'object'}}}])
            self.assertEqual(caught.exception.category,expected)
            failure.close()

    def test_authentication_errors_distinguish_401_from_403(self):
        for status, expected in ((401, '认证未通过'), (403, '请求被拒绝')):
            failure = urllib.error.HTTPError('https://provider.example/v1/chat/completions', status, 'fixture', {}, io.BytesIO(b'{}'))
            with self.subTest(status=status), patch.object(ai, 'current_config', return_value=('https://provider.example/v1', 'm', 'review-only-key')), patch.object(ai.urllib.request, 'urlopen', side_effect=failure), self.assertRaises(ai.AIError) as caught:
                ai.chat_completion([{'role': 'user', 'content': 'synthetic test'}])
            self.assertEqual(caught.exception.category, 'authentication')
            self.assertIn(f'HTTP {status}', caught.exception.message)
            self.assertIn(expected, caught.exception.message)
            self.assertNotIn('review-only-key', caught.exception.message)
            failure.close()


if __name__ == "__main__":
    unittest.main()
