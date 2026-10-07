"""Model-driven, text-only paper access and model consistency under isolated data."""
import asyncio
import json
import re
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from backend import ai, app
from backend.db import connect
from review import test_translation_flow as flow
from review.math_prompt_checks import assert_math_prompt


def tool_result(name, arguments=None):
    calls = [{'id': 'review_call', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments or {})}}]
    return {'content': '', 'tool_calls': calls, 'message': {'role': 'assistant', 'content': None, 'tool_calls': calls}, 'usage': None}


class ToolChatReview(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.config = patch.object(ai, 'current_config', return_value=('http://127.0.0.1:9999/custom/?route=literal', 'default-model', 'review-only-key'))
        self.config.start()

    def tearDown(self):
        self.config.stop()
        flow.TranslationFlowReview.tearDown(self)

    def ready_paper(self, name='quartz_alpha.pdf'):
        paper_id = app.import_pdf(str(flow.FIXTURES / name))['paper']['id']
        app.store_status(paper_id, 'translating')
        asyncio.run(app.translate_paper(paper_id))
        return paper_id

    def test_unrelated_question_is_one_request_without_paper_text_or_images(self):
        paper = self.ready_paper()
        with patch.object(ai, 'chat_completion', return_value={'content': '2 + 2 = 4', 'usage': None}) as request, patch.object(app, 'retrieve_segments') as retrieve, patch.object(app, 'start_summary') as summarize:
            answer = asyncio.run(app.chat(paper, app.ChatInput(question='2+2是多少', model='chosen-A')))
        self.assertEqual(answer['status'], 'completed')
        self.assertEqual(request.call_count, 1)
        self.assertFalse(retrieve.called)
        self.assertFalse(summarize.called)
        sent = json.dumps(request.call_args.args[0])
        self.assertNotIn('QUARTZ_METHOD_N', sent)
        self.assertNotIn('137', sent)
        self.assertNotIn('image_url', sent)
        self.assertTrue(request.call_args.kwargs.get('tools'))
        self.assertEqual(request.call_args.kwargs['model'], 'chosen-A')
        assert_math_prompt(self, request.call_args.args[0])
        self.assertEqual(answer['sources'], [])

    def test_selected_model_stays_fixed_across_text_tool_rounds(self):
        paper = self.ready_paper()
        requests = []
        def completion(messages, **kwargs):
            requests.append((messages.copy(), kwargs))
            if len(requests) == 1:
                return tool_result('read_paper', {'query': 'QUARTZ_METHOD_N'})
            tool = messages[-1]
            self.assertEqual(tool['role'], 'tool')
            self.assertEqual(tool['tool_call_id'], 'review_call')
            self.assertIn('QUARTZ_METHOD_N=137', tool['content'])
            self.assertNotIn('image_url', tool['content'])
            source = json.loads(tool['content'])['excerpts'][0]['source_id']
            return {'content': f'137 samples [{source}]', 'usage': None}
        with patch.object(ai, 'chat_completion', side_effect=completion):
            answer = asyncio.run(app.chat(paper, app.ChatInput(question='这篇的样本是多少', model='chosen-A')))
        self.assertEqual(len(requests), 2)
        self.assertTrue(all(kwargs['model'] == 'chosen-A' for _, kwargs in requests))
        self.assertNotIn('QUARTZ_METHOD_N', json.dumps(requests[0][0]))
        self.assertEqual(answer['status'], 'completed')
        self.assertTrue(answer['sources'])
        self.assertEqual(len(app.get_chat(paper)), 2)

    def test_full_summary_is_a_model_tool_choice_and_covers_every_page(self):
        paper = self.ready_paper('long_paper.pdf')
        question = '请解释这项研究，特别关注实验设计'
        requests = []
        def completion(messages, **kwargs):
            text = '\n'.join(message.get('content') or '' for message in messages)
            requests.append((kwargs, text))
            if len(requests) == 1:
                return tool_result('summarize_paper')
            ids = re.findall(r'\[(S\d+)\]', text)
            return {'content': f'测试研究设计 [{ids[0]}]', 'usage': None}
        with patch.object(ai, 'chat_completion', side_effect=completion):
            answer = asyncio.run(app.chat(paper, app.ChatInput(question=question, model='chosen-A')))
        self.assertEqual(answer['status'], 'completed')
        self.assertEqual(len(requests), 2, 'One tool decision and one complete-paper answer; no synthesis round')
        body = requests[1][1]
        for page in range(1, 25):
            self.assertIn(f'COVERAGE_PAGE_{page:02d}', body)
        self.assertTrue(all(kwargs['model'] == 'chosen-A' for kwargs, _ in requests))
        self.assertIn(question, body)
        self.assertNotIn('image_url', body)
        self.assertNotIn('COVERAGE_PAGE_', requests[0][1])
        for _, text in requests:
            for marker in ('LaTeX', '$$', r'\sum', r'\frac', '下标', '上标'):
                self.assertIn(marker, text)
        self.assertEqual([item['role'] for item in app.get_chat(paper)], ['user', 'assistant'])

    def test_current_paper_tool_cannot_read_another_papers_content(self):
        self.ready_paper()
        paper = self.ready_paper('quartz_beta_same_title.pdf')
        calls = []
        def completion(messages, **kwargs):
            calls.append(messages.copy())
            if len(calls) == 1:
                return tool_result('read_paper', {'query': 'QUARTZ_METHOD_N'})
            evidence = messages[-1]['content']
            self.assertIn('QUARTZ_METHOD_N=249', evidence)
            self.assertNotIn('QUARTZ_METHOD_N=137', evidence)
            source = json.loads(evidence)['excerpts'][0]['source_id']
            return {'content': f'249 [{source}]', 'usage': None}
        with patch.object(ai, 'chat_completion', side_effect=completion):
            answer = asyncio.run(app.chat(paper, app.ChatInput(question='读取样本', model='chosen-A')))
        self.assertEqual(answer['status'], 'completed')
        self.assertEqual(len(calls), 2)

    def test_unknown_tool_and_malformed_arguments_never_expose_body(self):
        for result in (tool_result('read_file', {'path': 'D:/private.pdf'}), tool_result('read_paper', {'query': 17}), tool_result('read_paper', {'paper_id': 'another-paper', 'query': 'samples'})):
            with self.subTest(result=result):
                paper = self.ready_paper()
                with patch.object(ai, 'chat_completion', return_value=result), patch.object(app, 'retrieve_segments') as read:
                    with self.assertRaises(HTTPException):
                        asyncio.run(app.chat(paper, app.ChatInput(question='读取', model='chosen-A')))
                self.assertFalse(read.called)
                self.assertFalse(any(item['role'] == 'assistant' for item in app.get_chat(paper)))

    def test_tool_loop_is_bounded_and_never_reports_partial_answer(self):
        paper = self.ready_paper()
        with patch.object(ai, 'chat_completion', return_value=tool_result('read_paper', {'query': 'QUARTZ_METHOD_N'})) as requests:
            with self.assertRaises(HTTPException):
                asyncio.run(app.chat(paper, app.ChatInput(question='读取', model='chosen-A')))
        self.assertLessEqual(requests.call_count, 10)
        self.assertFalse(any(item['role'] == 'assistant' for item in app.get_chat(paper)))

    def test_summary_error_retries_whole_prompt_with_original_model(self):
        paper = self.ready_paper('long_paper.pdf')
        chunks = []
        def completion(messages, **kwargs):
            text = '\n'.join(message.get('content') or '' for message in messages)
            if kwargs.get('tools') and messages[-1]['role'] != 'tool':
                return tool_result('summarize_paper')
            chunks.append(text)
            raise ai.AIError('incomplete_response', 'review truncation')
        with patch.object(ai, 'chat_completion', side_effect=completion):
            failed = asyncio.run(app.chat(paper, app.ChatInput(question='解读研究', model='chosen-A')))
        self.assertEqual(failed['status'], 'error')
        self.assertEqual(failed['completed_chunks'], 0)
        self.assertEqual(failed['total_chunks'], 0)
        self.assertEqual(failed['kind'], 'full_prompt')
        self.assertEqual(len(chunks), 1)
        self.assertEqual([item['role'] for item in app.get_chat(paper)], ['user'])
        resumed = []
        def finish(messages, **kwargs):
            text = '\n'.join(message.get('content') or '' for message in messages)
            resumed.append((kwargs, text))
            source = re.findall(r'\[(S\d+)\]', text)[0]
            return {'content': f'恢复摘要 [{source}]', 'usage': None}
        with patch.object(ai, 'chat_completion', side_effect=finish):
            completed = asyncio.run(app.resume_analysis(paper, failed['id']))
        self.assertEqual(completed['status'], 'completed')
        self.assertEqual([text for kwargs, text in resumed], chunks)
        self.assertTrue(all(kwargs['model'] == 'chosen-A' for kwargs, _ in resumed))

    def test_page_tool_reads_only_requested_pages_and_limits_text(self):
        paper = self.ready_paper()
        calls = []
        def completion(messages, **kwargs):
            calls.append(messages.copy())
            if len(calls) == 1:
                return tool_result('read_paper', {'start_page': 2, 'end_page': 3})
            result = json.loads(messages[-1]['content'])
            self.assertEqual(result['status'], 'ok')
            self.assertTrue(result['excerpts'])
            self.assertLessEqual(sum(len(item['text']) for item in result['excerpts']), 12000)
            for item in result['excerpts']:
                self.assertGreaterEqual(item['start_page'], 2)
                self.assertLessEqual(item['end_page'], 3)
                self.assertNotIn('QUARTZ_APPENDIX_SEED', item['text'])
            return {'content': '指定页读取完成', 'usage': None}
        with patch.object(ai, 'chat_completion', side_effect=completion):
            answer = asyncio.run(app.chat(paper, app.ChatInput(question='只读第2到3页', model='chosen-A')))
        self.assertEqual(answer['status'], 'completed')

    def test_model_configuration_requires_no_key_and_persists_reader_override(self):
        import httpx
        import os
        paper = self.ready_paper()
        async def exercise():
            with patch.dict(os.environ, {'WORKBENCH_SESSION_TOKEN': 'tool-model-review'}), patch.object(ai, 'save_api_key') as save_key, patch.object(ai, 'key_is_configured', return_value=False):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url='http://test', headers={'Authorization': 'Bearer tool-model-review'}) as client:
                    options = await client.put('/settings/models', json={'models': ['chosen-A', 'chosen-B']})
                    self.assertEqual(options.status_code, 200, options.text)
                    model = await client.patch(f'/papers/{paper}/model', json={'model': 'chosen-B'})
                    self.assertEqual(model.status_code, 200, model.text)
                    restored = await client.get(f'/papers/{paper}')
                    self.assertEqual(restored.json()['model_override'], 'chosen-B')
                    settings = await client.get('/settings')
                    self.assertIn('chosen-A', settings.json()['model_options'])
                    self.assertIn('chosen-B', settings.json()['model_options'])
                    self.assertFalse(settings.json()['key_configured'])
                    self.assertFalse(save_key.called)
                    with patch.object(ai, 'chat_completion', return_value={'content': '普通聊天', 'usage': None}) as request:
                        answer = await client.post(f'/papers/{paper}/chat', json={'question': '2+2是多少'})
                    self.assertEqual(answer.status_code, 200, answer.text)
                    self.assertEqual(request.call_args.kwargs['model'], 'chosen-B')
        asyncio.run(exercise())

    def test_large_excerpt_is_bounded_and_explicitly_reports_truncation(self):
        paper = self.ready_paper()
        with connect() as db:
            db.execute("UPDATE segments SET original_text=? WHERE id=(SELECT id FROM segments WHERE paper_id=? ORDER BY sequence_no LIMIT 1)", ('large_excerpt_marker ' + 'x' * 15000 + ' BEYOND_LIMIT_SENTINEL', paper))
        calls = []
        def completion(messages, **kwargs):
            calls.append(messages.copy())
            if len(calls) == 1:
                return tool_result('read_paper', {'query': 'large_excerpt_marker'})
            result = json.loads(messages[-1]['content'])
            self.assertTrue(result['truncated'])
            self.assertLessEqual(sum(len(item['text']) for item in result['excerpts']), 12000)
            self.assertNotIn('BEYOND_LIMIT_SENTINEL', messages[-1]['content'])
            return {'content': '长段落已截取，更多内容需要继续按页查询', 'usage': None}
        with patch.object(ai, 'chat_completion', side_effect=completion):
            result = asyncio.run(app.chat(paper, app.ChatInput(question='读取长段落', model='chosen-A')))
        self.assertEqual(result['status'], 'completed')


if __name__ == '__main__':
    unittest.main()
