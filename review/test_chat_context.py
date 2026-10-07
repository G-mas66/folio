"""Verify document attachment and whole-paper coverage independently of a model."""

import asyncio
import json
import re
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from backend import ai, app
from backend.db import connect
from review import test_translation_flow as flow


FIXTURES = flow.FIXTURES


class ChatContextReview(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.config = patch.object(ai, 'current_config', return_value=('http://127.0.0.1:9999/custom', 'review-model', 'review-only-key'))
        self.config.start()

    def tearDown(self):
        self.config.stop()
        flow.TranslationFlowReview.tearDown(self)

    def ready_paper(self, name):
        paper_id = app.import_pdf(str(FIXTURES / name))["paper"]["id"]
        app.store_status(paper_id, "translating")
        with patch("review.test_translation_flow.translate_text", side_effect=flow.fake_translation):
            asyncio.run(app.translate_paper(paper_id))
        return paper_id

    def test_paper_summary_tools_are_available_for_natural_requests(self):
        paper_id = self.ready_paper('quartz_alpha.pdf')
        for question in ("详细总结一下这篇文献", "总结这篇文章", "这篇文献讲了什么", "概括全文"):
            with self.subTest(question=question), patch.object(ai, 'chat_completion', return_value={'content': '模型自行选择是否调用工具', 'usage': None}) as request:
                asyncio.run(app.chat(paper_id, app.ChatInput(question=question)))
                self.assertEqual(request.call_count, 1, 'question wording must not bypass the model tool decision')
                self.assertTrue(any(tool['function']['name'] == 'summarize_paper' for tool in request.call_args.kwargs['tools']))

    def test_long_summary_sends_every_page_and_preserves_user_focus(self):
        paper_id = self.ready_paper("long_paper.pdf")
        question = "详细总结一下这篇文献，重点解释实验设计"
        requests = []

        def completion(messages, **kwargs):
            text = "\n".join(message.get("content") or "" for message in messages)
            requests.append((kwargs.get("operation"), text))
            source_ids = re.findall(r"\[(S\d+)\]", text)
            return {"content": "测试要点 " + (f"[{source_ids[0]}]" if source_ids else ""), "usage": None}

        with patch.object(ai, "chat_completion", side_effect=completion):
            result = asyncio.run(app.start_summary(paper_id, question))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(requests), 1, 'Whole-paper summary must use one text prompt')
        self.assertEqual(result['kind'], 'full_prompt')
        self.assertEqual(result['total_chunks'], 0)
        body = requests[0][1]
        for page in range(1, 25):
            self.assertIn(f"COVERAGE_PAGE_{page:02d}", body)
        positions = [body.index(f'COVERAGE_PAGE_{page:02d}') for page in range(1,25)]
        self.assertEqual(positions,sorted(positions),'The complete prompt must preserve original page order')
        self.assertIn(question, body)
        self.assertNotIn('image_url', body)

    def test_summary_failure_never_adds_a_partial_assistant_answer(self):
        paper_id = self.ready_paper("long_paper.pdf")
        calls = []

        def fail_full_prompt(messages, **kwargs):
            text = "\n".join(message.get("content") or "" for message in messages)
            calls.append(text)
            raise ai.AIError("incomplete_response", "test truncated summary")

        with patch.object(ai, "chat_completion", side_effect=fail_full_prompt):
            failed = asyncio.run(app.start_summary(paper_id, "详细总结一下这篇文献"))
        self.assertEqual(failed["status"], "error")
        self.assertEqual(failed["completed_chunks"], 0)
        self.assertEqual(failed['total_chunks'], 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual([message["role"] for message in app.get_chat(paper_id)], ["user"])
        resumed_requests = []

        def resumed(messages, **kwargs):
            text = "\n".join(message.get("content") or "" for message in messages)
            resumed_requests.append(text)
            source = re.findall(r"\[(S\d+)\]", text)[0]
            return {"content": f"测试要点 [{source}]", "usage": None}

        with patch.object(ai, "chat_completion", side_effect=resumed):
            completed = asyncio.run(app.execute_summary(failed["id"]))
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(resumed_requests, calls, 'Retry must resend the complete prompt')

    def test_chat_api_failure_is_reported_as_api_failure(self):
        paper_id = self.ready_paper("quartz_alpha.pdf")
        with patch.object(ai, "chat_completion", side_effect=ai.AIError("network", "test network failure")):
            with self.assertRaises(HTTPException) as caught:
                asyncio.run(app.chat(paper_id, app.ChatInput(question="样本有多少")))
        self.assertEqual(caught.exception.status_code, 502)
        self.assertNotIn("没有找到足够证据", str(caught.exception.detail))

    def test_legacy_partial_summary_reuses_completed_chunks_on_resume(self):
        paper_id = self.ready_paper('long_paper.pdf')
        with connect() as db:
            rows = [dict(row) for row in db.execute('SELECT * FROM segments WHERE paper_id=? ORDER BY sequence_no', (paper_id,))]
            groups = app.summary_groups(rows)
            self.assertGreater(len(groups), 1)
            db.execute("INSERT INTO analysis_runs(id,paper_id,kind,question,status,model_snapshot,created_at,updated_at) VALUES('legacy-run',?,'full_summary','旧版要求','error','legacy-model',?,?)", (paper_id, app.now(), app.now()))
            for index, group in enumerate(groups):
                ids = [f"S{row['id']}" for row in group]
                db.execute('INSERT INTO analysis_chunks(run_id,chunk_no,source_ids_json,response,status) VALUES(?,?,?,?,?)', ('legacy-run',index,json.dumps(ids),f'已有摘要 [{ids[0]}]' if index == 0 else '', 'completed' if index == 0 else 'pending'))
        requests = []
        def completion(messages, **kwargs):
            body = '\n'.join(message.get('content') or '' for message in messages)
            requests.append((kwargs,body))
            source = re.findall(r'\[(S\d+)\]',body)[0]
            return {'content':f'恢复旧任务 [{source}]','usage':None}
        with patch.object(ai,'chat_completion',side_effect=completion):
            result = asyncio.run(app.resume_analysis(paper_id,'legacy-run'))
        self.assertEqual(result['status'],'completed')
        self.assertTrue(all(kwargs['model']=='legacy-model' for kwargs,_ in requests))
        rerun = '\n'.join(body for kwargs,body in requests if kwargs.get('operation')=='full_summary_chunk')
        for row in groups[0]:
            self.assertNotIn(row['original_text'],rerun)

    def test_full_prompt_keeps_oversize_body_and_failure_without_fallback(self):
        paper_id = self.ready_paper('quartz_alpha.pdf')
        whole = 'BEGIN_FULL_SENTINEL ' + '正文 ' * 20000 + ' END_FULL_SENTINEL'
        with connect() as db:
            db.execute('UPDATE segments SET original_text=? WHERE paper_id=? AND sequence_no=1',(whole,paper_id))
        def rejected(messages, **kwargs):
            body = '\n'.join(message.get('content') or '' for message in messages)
            self.assertIn(whole,body)
            self.assertTrue(all(isinstance(message['content'],str) for message in messages))
            self.assertEqual(kwargs['model'],'mimo-v6pro')
            raise ai.AIError('context_length','上下文容量不足')
        with patch.object(ai,'chat_completion',side_effect=rejected) as request:
            result = asyncio.run(app.start_summary(paper_id,'详细总结',model='mimo-v6pro'))
        self.assertEqual(request.call_count,1)
        self.assertEqual(result['status'],'error')
        self.assertIn('上下文',result['error'])
        self.assertEqual(result['total_chunks'],0)
        self.assertEqual([message['role'] for message in app.get_chat(paper_id)],['user'])

    def test_followup_tool_decision_receives_recent_context(self):
        paper_id = self.ready_paper("quartz_alpha.pdf")
        app.add_chat_message(paper_id, "user", "对照组如何设置")
        app.add_chat_message(paper_id, "assistant", "方法章节包含参考组和处理组。")
        decision_requests = []

        def completion(messages, **kwargs):
            text = "\n".join(message.get("content") or "" for message in messages)
            decision_requests.append(text)
            return {"content": "方法说明，需要时可调用文献工具。", "usage": None}

        with patch.object(ai, "chat_completion", side_effect=completion):
            asyncio.run(app.chat(paper_id, app.ChatInput(question="为什么这样做")))
        self.assertEqual(len(decision_requests), 1)
        self.assertIn("对照组如何设置", decision_requests[0])
        self.assertIn("方法章节包含参考组和处理组", decision_requests[0])

    def test_document_question_only_receives_current_paper(self):
        self.ready_paper("quartz_alpha.pdf")
        beta = self.ready_paper("quartz_beta_same_title.pdf")
        requests = []

        def completion(messages, **kwargs):
            text = "\n".join(message.get("content") or "" for message in messages)
            requests.append(text)
            if len(requests) == 1:
                return {'content': '', 'tool_calls': [{'id': 'read_beta', 'type': 'function', 'function': {'name': 'read_paper', 'arguments': '{"query":"QUARTZ_METHOD_N"}'}}], 'usage': None}
            source = json.loads(messages[-1]['content'])['excerpts'][0]['source_id']
            return {"content": f"249 samples [{source}]", "usage": None}

        with patch.object(ai, "chat_completion", side_effect=completion):
            result = asyncio.run(app.chat(beta, app.ChatInput(question="QUARTZ_METHOD_N")))
        self.assertEqual(result["status"], "completed")
        self.assertIn("QUARTZ_METHOD_N=249", requests[1])
        self.assertNotIn("QUARTZ_METHOD_N=137", requests[1])
        self.assertEqual(len(app.get_chat(beta)), 2)


if __name__ == "__main__":
    unittest.main()
