"""Selection context, pending agent writes, and annotation ordering contracts."""

import asyncio
import json
import os
import unittest
from unittest.mock import patch

import httpx

from backend import ai, app
from backend.db import connect
from review import test_translation_flow as flow


class AgentActionsContract(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.token = patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "agent-actions-review-token"})
        self.token.start()
        self.first = app.import_pdf(str(flow.FIXTURES / "quartz_alpha.pdf"))["paper"]["id"]
        self.second = app.import_pdf(str(flow.FIXTURES / "quartz_beta_same_title.pdf"))["paper"]["id"]
        with connect() as db:
            # The fixture PDFs remain the stored originals; treating them as Chinese
            # papers keeps these tests independent of the translation worker.
            db.execute("UPDATE papers SET source_language = 'zh', status = 'completed' WHERE id IN (?, ?)", (self.first, self.second))

    def tearDown(self):
        self.token.stop()
        flow.TranslationFlowReview.tearDown(self)

    def request(self, method, path, body=None, token="agent-actions-review-token"):
        async def call():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": f"Bearer {token}"},
            ) as client:
                return await client.request(method, path, json=body)
        return asyncio.run(call())

    def session(self, paper=None):
        paper = paper or self.first
        response = self.request("GET", f"/papers/{paper}/chat-sessions")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()[0]["id"]

    @staticmethod
    def context(selected_text="selected quotation"):
        return {
            "pdf_kind": "original", "page_no": 1, "selected_text": selected_text,
            "rects": [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.02}],
        }

    def test_chat_selection_is_session_scoped_and_rejects_bad_bounds(self):
        session_id = self.session()
        other_session = self.request("POST", f"/papers/{self.first}/chat-sessions").json()["id"]
        body = {"selection_context": self.context("specific selected text")}
        saved = self.request("PUT", f"/papers/{self.first}/chat-sessions/{session_id}/selection", body)
        self.assertEqual(saved.status_code, 200, saved.text)
        sessions = self.request("GET", f"/papers/{self.first}/chat-sessions").json()
        self.assertEqual(next(row for row in sessions if row["id"] == session_id)["selection_context"], saved.json()["selection_context"])
        self.assertIsNone(next(row for row in sessions if row["id"] == other_session)["selection_context"])

        invalid = [
            {**self.context(), "page_no": 0},
            {**self.context(), "rects": [{"x": -0.1, "y": 0.2, "width": 0.3, "height": 0.02}]},
            {**self.context(), "rects": [{"x": 0.8, "y": 0.2, "width": 0.3, "height": 0.02}]},
        ]
        for selection in invalid:
            with self.subTest(selection=selection):
                self.assertEqual(self.request("PUT", f"/papers/{self.first}/chat-sessions/{session_id}/selection", {"selection_context": selection}).status_code, 422)
        self.assertEqual(self.request("PUT", f"/papers/{self.first}/chat-sessions/{other_session}/selection", {"selection_context": None}).status_code, 200)
        loaded = self.request("GET", f"/papers/{self.first}/chat-sessions").json()
        self.assertIsNone(next(row for row in loaded if row["id"] == other_session)["selection_context"])
        self.assertEqual(self.request("PUT", f"/papers/{self.second}/chat-sessions/{session_id}/selection", body).status_code, 404)

    def test_annotation_confirmation_is_pending_then_idempotent_and_paper_scoped(self):
        session_id = self.session()
        context = app.normalize_selection_context(self.context(), app.require_paper(self.first)["page_count"])
        action = app.prepare_annotation_action(
            app.require_paper(self.first), session_id, None,
            {"question": "这句是什么意思？", "explanation": "解释草稿。", "quote": "selected quotation", "use_selection": True},
            context,
        )
        self.assertEqual(action["status"], "pending")
        self.assertEqual(self.request("GET", f"/papers/{self.first}/annotations").json(), [])
        self.assertEqual(self.request("GET", f"/papers/{self.first}/agent-actions?session_id={session_id}").json(), [action])
        route = f"/papers/{self.first}/agent-actions/{action['id']}/confirm"
        self.assertEqual(self.request("POST", f"/papers/{self.second}/agent-actions/{action['id']}/confirm", {}).status_code, 404)
        confirmed = self.request("POST", route, {"comment": "编辑后的批注"})
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        result = confirmed.json()
        self.assertEqual(result["status"], "applied")
        self.assertEqual(result["result"]["annotation"]["comment"], "编辑后的批注")
        self.assertEqual(result["result"]["annotation"]["selected_text"], "selected quotation")
        self.assertEqual(self.request("POST", route, {"comment": "ignored on idempotent retry"}).json(), result)
        self.assertEqual(len(self.request("GET", f"/papers/{self.first}/annotations").json()), 1)

    def test_unmatched_annotation_requires_explicit_manual_reselection(self):
        session_id = self.session()
        action = app.prepare_annotation_action(
            app.require_paper(self.first), session_id, None,
            {"question": "Why?", "explanation": "A grounded draft.", "quote": "not present in the source"}, None,
        )
        self.assertEqual(action["payload"]["location_status"], "not_found")
        route = f"/papers/{self.first}/agent-actions/{action['id']}/confirm"
        self.assertEqual(self.request("POST", route, {}).status_code, 409)
        reselected = self.context("new explicit PDF target")
        confirmed = self.request("POST", route, {"manual_reselect": True, "selection_context": reselected})
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertEqual(confirmed.json()["result"]["annotation"]["selected_text"], "new explicit PDF target")

    def test_note_confirmation_conflict_cancel_and_idempotency(self):
        session_id = self.session()
        action = app.create_agent_action(self.first, session_id, None, "note", {"text": "草稿笔记"})
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], "")
        route = f"/papers/{self.first}/agent-actions/{action['id']}/confirm"
        self.assertEqual(self.request("POST", route, {"expected_note_text": "", "text": "编辑后的笔记"}).status_code, 200)
        confirmed = self.request("POST", route, {"expected_note_text": "", "text": "重试文字"})
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertEqual(confirmed.json()["result"]["notes"]["text"], "编辑后的笔记")
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], "编辑后的笔记")

        conflicted = app.create_agent_action(self.first, session_id, None, "note", {"text": "另一个草稿"})
        self.assertEqual(self.request("POST", f"/papers/{self.first}/agent-actions/{conflicted['id']}/confirm", {"expected_note_text": ""}).status_code, 409)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/agent-actions?session_id={session_id}").json()[-1]["status"], "pending")

        cancelled = app.create_agent_action(self.first, session_id, None, "note", {"text": "取消草稿"})
        cancel_route = f"/papers/{self.first}/agent-actions/{cancelled['id']}/cancel"
        first_cancel = self.request("POST", cancel_route)
        self.assertEqual(first_cancel.status_code, 200, first_cancel.text)
        self.assertEqual(first_cancel.json()["status"], "cancelled")
        self.assertEqual(self.request("POST", cancel_route).json(), first_cancel.json())
        self.assertEqual(self.request("POST", f"/papers/{self.first}/agent-actions/{cancelled['id']}/confirm", {"expected_note_text": "编辑后的笔记"}).status_code, 409)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], "编辑后的笔记")

    def test_chat_tool_prepares_note_without_mutation_until_confirmed(self):
        session_id = self.session()
        call = {
            "id": "prepare_note_1", "type": "function",
            "function": {"name": "prepare_note", "arguments": json.dumps({"text": "摘要笔记草稿"}, ensure_ascii=False)},
        }
        replies = [
            {"content": "", "tool_calls": [call], "message": {"role": "assistant", "content": None, "tool_calls": [call]}},
            {"content": "已准备一条待确认笔记。", "reasoning": "最后一步分析"},
        ]
        with patch.object(ai, "current_config", return_value=("https://gateway.test/v1", "test-model", "key")), \
             patch.object(ai, "current_protocol", return_value="openai_chat_completions"), \
             patch.object(ai, "chat_completion", side_effect=replies) as completion:
            response = self.request("POST", f"/papers/{self.first}/chat", {"question": "请添加笔记", "session_id": session_id})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["reasoning"], "最后一步分析")
        self.assertNotIn("thinking", completion.call_args.kwargs)
        self.assertNotIn("reasoning_effort", completion.call_args.kwargs)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], "")
        actions = self.request("GET", f"/papers/{self.first}/agent-actions?session_id={session_id}").json()
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["payload"]["text"], "摘要笔记草稿")

    def test_stream_chat_emits_a_persistent_pending_action(self):
        session_id = self.session()
        call = {
            "id": "prepare_note_stream_1", "type": "function",
            "function": {"name": "prepare_note", "arguments": json.dumps({"text": "流式笔记草稿"}, ensure_ascii=False)},
        }
        turns = 0

        async def stream(messages, **kwargs):
            nonlocal turns
            turns += 1
            if turns == 1:
                yield {"type": "result", "result": {
                    "content": "", "tool_calls": [call],
                    "message": {"role": "assistant", "content": None, "tool_calls": [call]},
                }}
            else:
                yield {"type": "content_delta", "text": "待确认笔记已准备。"}
                yield {"type": "result", "result": {"content": "待确认笔记已准备。", "tool_calls": []}}

        with patch.object(ai, "current_config", return_value=("https://gateway.test/v1", "test-model", "key")), \
             patch.object(ai, "current_protocol", return_value="openai_chat_completions"), \
             patch.object(ai, "stream_chat_completion", side_effect=stream):
            response = self.request("POST", f"/papers/{self.first}/chat/stream", {
                "question": "添加笔记", "session_id": session_id, "request_id": "a" * 32, "web_search": False,
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("event: agent_action\n", response.text)
        self.assertIn('"status": "pending"', response.text)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], "")
        actions = self.request("GET", f"/papers/{self.first}/agent-actions?session_id={session_id}").json()
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["payload"]["text"], "流式笔记草稿")

    def test_sync_deepseek_chat_replays_saved_reasoning_on_the_next_turn(self):
        session_id = self.session()
        received = []

        def complete(messages, **kwargs):
            received.append(messages)
            return {"content": f"第 {len(received)} 次回答", "reasoning": f"推理过程 {len(received)}"}

        with patch.object(ai, "current_config", return_value=("http://127.0.0.1:8080/v1", "deepseek-flash", "key")), \
             patch.object(ai, "current_protocol", return_value="openai_chat_completions"), \
             patch.object(ai, "chat_completion", side_effect=complete):
            first = self.request("POST", f"/papers/{self.first}/chat", {"question": "第一问", "session_id": session_id})
            second = self.request("POST", f"/papers/{self.first}/chat", {"question": "第二问", "session_id": session_id})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()["reasoning"], "推理过程 1")
        prior_assistant = next(message for message in received[1] if message.get("role") == "assistant")
        self.assertEqual(prior_assistant["reasoning_content"], "推理过程 1")

    def test_annotation_sort_uses_the_top_left_rect_anchor(self):
        def mark(comment, rects):
            response = self.request("POST", f"/papers/{self.first}/annotations", {
                "pdf_kind": "original", "page_no": 1, "kind": "comment", "color": "yellow",
                "selected_text": comment, "comment": comment, "rects": rects,
            })
            self.assertEqual(response.status_code, 200, response.text)

        mark("A", [
            {"x": 0.05, "y": 0.2, "width": 0.1, "height": 0.01},
            {"x": 0.25, "y": 0.1, "width": 0.1, "height": 0.01},
            {"x": 0.18, "y": 0.1, "width": 0.1, "height": 0.01},
        ])
        mark("B", [{"x": 0.17, "y": 0.1, "width": 0.1, "height": 0.01}])
        mark("C", [{"x": 0.19, "y": 0.1, "width": 0.1, "height": 0.01}])
        self.assertEqual([row["comment"] for row in self.request("GET", f"/papers/{self.first}/annotations").json()], ["B", "A", "C"])

    def test_ai_annotation_uses_selected_text_evidence_and_thinking_options(self):
        selection = self.context("137 independent samples")
        with patch.object(ai, "current_config", return_value=("https://gateway.test/v1", "test-model", "key")), \
             patch.object(ai, "current_protocol", return_value="openai_chat_completions"), \
             patch.object(ai, "chat_completion", return_value={"content": "该短语说明实验使用了 137 个独立样本。", "reasoning": "已核对上下文。"}) as completion:
            response = self.request("POST", f"/papers/{self.first}/ai-annotation", {
                "selection_context": selection, "question": "independent samples 表示什么？",
                "thinking": "enabled", "reasoning_effort": "high",
            })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("问题：independent samples 表示什么？", response.json()["comment"])
        self.assertIn("简要解释：该短语", response.json()["comment"])
        self.assertEqual(response.json()["reasoning"], "已核对上下文。")
        kwargs = completion.call_args.kwargs
        self.assertEqual(kwargs["thinking"], "enabled")
        self.assertEqual(kwargs["reasoning_effort"], "high")
        self.assertIn("137 independent samples", completion.call_args.args[0][1]["content"])

    def test_action_intent_supports_commands_and_scopes_negation_by_target(self):
        self.assertTrue(app.user_explicitly_requested_action("批注到这里", "annotation"))
        self.assertTrue(app.user_explicitly_requested_action("找到对应原文，把问题和简要解释批注进去", "annotation"))
        for question in (
            "选中内容标注一下", "请帮我在这里做标注", "给这句话标注一下",
            "帮我加一句批注", "在指定位置批注", "检索这段原文并拟一条批注", "找不到引用也先准备一条批注",
        ):
            with self.subTest(question=question):
                self.assertTrue(app.user_explicitly_requested_action(question, "annotation"))
        self.assertTrue(app.user_explicitly_requested_action("保存到笔记", "note"))
        self.assertTrue(app.user_explicitly_requested_action("追加到笔记", "note"))
        self.assertTrue(app.user_explicitly_requested_action("记入阅读笔记", "note"))
        self.assertFalse(app.user_explicitly_requested_action("解释作者为什么要保存到笔记", "note"))
        self.assertFalse(app.user_explicitly_requested_action("请解释作者为什么在指定位置批注", "annotation"))
        self.assertFalse(app.user_explicitly_requested_action("不要做批注，把这段话写到笔记里", "annotation"))
        self.assertTrue(app.user_explicitly_requested_action("不要做批注，把这段话写到笔记里", "note"))
        self.assertFalse(app.user_explicitly_requested_action("不要写进笔记，帮我做个批注", "note"))
        self.assertTrue(app.user_explicitly_requested_action("不要写进笔记，帮我做个批注", "annotation"))


if __name__ == "__main__":
    unittest.main()
