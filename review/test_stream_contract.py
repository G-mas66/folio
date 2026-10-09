"""Independent upstream HTTP/SSE and cancellation tests; isolated D-drive data."""
import asyncio
import json
import os
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import httpx
from backend import ai, app
from review import test_translation_flow as flow
from review.math_prompt_checks import assert_math_prompt


class StreamReview(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.token = patch.dict(os.environ, {'WORKBENCH_SESSION_TOKEN': 'stream-review-token'})
        self.token.start()
        self.requests = []
        self.request_user_agents = []
        self.request_authorization = []
        self.require_folio_user_agent = False
        self.rejection_status = None
        self.mode = 'normal'
        self.closed = threading.Event()
        owner = self

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                owner.requests.append({'path': self.path, **body})
                user_agent = self.headers.get('User-Agent')
                owner.request_user_agents.append(user_agent)
                owner.request_authorization.append(self.headers.get('Authorization'))
                if owner.require_folio_user_agent and user_agent != ai.API_USER_AGENT:
                    owner.rejection_status = 403
                if owner.rejection_status:
                    payload = json.dumps({'error': {'message': 'synthetic gateway rejection'}}).encode('utf-8')
                    self.send_response(owner.rejection_status)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()

                def frame(delta, finish=None):
                    raw = ('data: ' + json.dumps({'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}, ensure_ascii=False) + '\r\n\r\n').encode()
                    for offset in range(0, len(raw), 37):
                        self.wfile.write(raw[offset:offset + 37])
                    self.wfile.flush()
                    time.sleep(.04)

                try:
                    self.wfile.write(b': heartbeat\r\n\r\n')
                    frame({'reasoning_content': '实际返回的思考第一段。'})
                    frame({'reasoning_content': '思考第二段。'})
                    if owner.mode == 'cancel' or (owner.mode == 'summary_cancel' and not body.get('tools')):
                        for _ in range(200):
                            frame({'reasoning_content': '仍在思考。'})
                    elif owner.mode in ('summary', 'summary_cancel') and body.get('tools'):
                        frame({'tool_calls': [{'index': 0, 'id': 'review_summary', 'type': 'function', 'function': {'name': 'summarize_paper', 'arguments': '{'}}]})
                        frame({'tool_calls': [{'index': 0, 'function': {'arguments': '}'}}]})
                        frame({}, 'tool_calls')
                    else:
                        frame({'content': '第一段正文。'})
                        frame({'content': '第二段正文。'})
                        if owner.mode == 'eof':
                            return
                        frame({}, 'length' if owner.mode == 'length' else 'stop')
                    self.wfile.write(b'data: [DONE]\r\n\r\n')
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    owner.closed.set()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/literal/custom/?r=keep%2Bquery'
        self.config = patch.object(ai, 'current_config', return_value=(self.url, 'default-model', 'review-only-key'))
        self.config.start()
        self.paper = app.import_pdf(str(flow.FIXTURES / 'long_paper.pdf'))['paper']['id']
        app.store_status(self.paper, 'translating')
        asyncio.run(app.translate_paper(self.paper))

    def tearDown(self):
        self.config.stop()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.token.stop()
        flow.TranslationFlowReview.tearDown(self)

    def client(self):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url='http://test', headers={'Authorization': 'Bearer stream-review-token'})

    async def stream(self, client, question='普通问题', request_id=None):
        response = await client.post(f'/papers/{self.paper}/chat/stream', json={'question': question, 'model': 'chosen-stream', 'web_search': False, 'request_id': request_id or uuid.uuid4().hex})
        self.assertEqual(response.status_code, 200, response.text)
        return response.text

    def test_real_sse_unicode_reasoning_and_literal_url(self):
        async def run():
            async with self.client() as client:
                return await self.stream(client)
        events = asyncio.run(run())
        self.assertIn('reasoning_delta', events)
        self.assertIn('content_delta', events)
        self.assertIn('done', events)
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual(request['path'], '/literal/custom/?r=keep%2Bquery')
        self.assertEqual(self.request_user_agents, [ai.API_USER_AGENT])
        self.assertEqual(self.request_authorization, ['Bearer review-only-key'])
        self.assertTrue(request['stream'])
        self.assertEqual(request['model'], 'chosen-stream')
        assert_math_prompt(self, request['messages'])
        self.assertNotIn('COVERAGE_PAGE_', json.dumps(request['messages']))
        self.assertTrue(all(tool['function']['name'] != 'web_search' for tool in request['tools']))
        message = app.get_chat(self.paper)[-1]
        self.assertEqual(message['status'], 'completed')
        self.assertEqual(message['content'], '第一段正文。第二段正文。')
        self.assertEqual(message['reasoning'], '实际返回的思考第一段。思考第二段。')

    def test_stream_uses_folio_user_agent_required_by_gateway(self):
        self.require_folio_user_agent = True

        async def run():
            async with self.client() as client:
                return await self.stream(client)

        events = asyncio.run(run())
        self.assertIn('event: done', events)
        self.assertEqual(self.request_user_agents, [ai.API_USER_AGENT])

    def test_stream_authentication_errors_distinguish_401_from_403(self):
        for status, expected in ((401, '认证未通过'), (403, '请求被拒绝')):
            self.rejection_status = status

            async def run():
                async with self.client() as client:
                    return await self.stream(client, question=f'synthetic {status}')

            events = asyncio.run(run())
            self.assertIn(f'HTTP {status}', events)
            self.assertIn(expected, events)

    def test_stop_closes_real_upstream_and_preserves_incomplete_reasoning(self):
        self.mode = 'cancel'
        request_id = uuid.uuid4().hex
        async def run():
            async with self.client() as client:
                pending = asyncio.create_task(self.stream(client, request_id=request_id))
                for _ in range(100):
                    if self.requests:
                        break
                    await asyncio.sleep(.02)
                self.assertTrue(self.requests)
                await asyncio.sleep(.13)
                started = time.monotonic()
                cancelled = await client.post(f'/papers/{self.paper}/chat/stream/{request_id}/cancel')
                self.assertEqual(cancelled.status_code, 200, cancelled.text)
                result = await asyncio.wait_for(pending, 2)
                self.assertLess(time.monotonic() - started, 2)
                return result
        events = asyncio.run(run())
        self.assertIn('cancelled', events)
        self.assertNotIn('event: done', events)
        self.assertTrue(self.closed.wait(2), 'Upstream socket must be closed promptly')
        self.assertEqual(len(self.requests), 1)
        message = app.get_chat(self.paper)[-1]
        self.assertEqual(message['status'], 'cancelled')
        self.assertIn('思考第一段', message['reasoning'])

    def test_eof_and_length_are_incomplete_not_successful(self):
        for mode in ('eof', 'length'):
            self.mode = mode
            async def run():
                async with self.client() as client:
                    return await self.stream(client, question=f'{mode}问题')
            events = asyncio.run(run())
            self.assertIn('error', events)
            self.assertNotIn('event: done', events)
            message = app.get_chat(self.paper)[-1]
            self.assertNotEqual(message['status'], 'completed')
            self.assertIn('第一段正文', message['content'])
        self.mode = 'normal'
        async def finish():
            async with self.client() as client:
                return await self.stream(client, question='接下来新问题')
        asyncio.run(finish())
        self.assertNotIn('第一段正文', json.dumps(self.requests[-1]['messages'], ensure_ascii=False), 'Incomplete assistant content must not become completed model history')

    def test_fragmented_tool_call_sends_every_page_once(self):
        self.mode = 'summary'
        async def run():
            async with self.client() as client:
                return await self.stream(client, question='详细总结一下这篇文献')
        events = asyncio.run(run())
        self.assertIn('done', events)
        self.assertEqual(len(self.requests), 2)
        prompt = self.requests[1]
        self.assertNotIn('tools', prompt)
        text = '\n'.join(message['content'] for message in prompt['messages'])
        for page in range(1, 25):
            self.assertIn(f'COVERAGE_PAGE_{page:02d}', text)
        self.assertTrue(all(request['stream'] and request['model'] == 'chosen-stream' for request in self.requests))
        for request in self.requests:
            assert_math_prompt(self, request['messages'])

    def test_unauthorized_stream_makes_no_provider_request(self):
        async def run():
            async with self.client() as client:
                return await client.post(f'/papers/{self.paper}/chat/stream', headers={'Authorization': 'Bearer wrong-token'}, json={'question': '问题', 'request_id': uuid.uuid4().hex})
        result = asyncio.run(run())
        self.assertEqual(result.status_code, 401)
        self.assertEqual(self.requests, [])
        self.assertEqual(app.get_chat(self.paper), [])

    def test_cancelled_summary_resumes_with_original_model_and_complete_body(self):
        self.mode = 'summary_cancel'
        request_id = uuid.uuid4().hex
        async def run():
            async with self.client() as client:
                pending = asyncio.create_task(self.stream(client, question='详细总结文献', request_id=request_id))
                for _ in range(100):
                    if len(self.requests) == 2:
                        break
                    await asyncio.sleep(.02)
                self.assertEqual(len(self.requests), 2)
                await asyncio.sleep(.13)
                result = await client.post(f'/papers/{self.paper}/chat/stream/{request_id}/cancel')
                self.assertEqual(result.status_code, 200, result.text)
                await asyncio.wait_for(pending, 2)
                runs = app.get_analysis_runs(self.paper)
                self.assertEqual(len(runs), 1)
                self.assertIn(runs[0]['status'], ('interrupted', 'cancelled'))
                self.mode = 'normal'
                with patch.object(ai, 'current_config', return_value=(self.url, 'different-default', 'review-only-key')):
                    resumed = await client.post(f"/papers/{self.paper}/analysis/{runs[0]['id']}/stream", json={'request_id': uuid.uuid4().hex})
                self.assertEqual(resumed.status_code, 200, resumed.text)
                self.assertIn('done', resumed.text)
        asyncio.run(run())
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(self.requests[-1]['model'], 'chosen-stream')
        self.assertEqual(self.requests[-1]['messages'], self.requests[-2]['messages'])
        self.assertEqual(app.get_analysis_runs(self.paper), [])


if __name__ == '__main__':
    unittest.main()
