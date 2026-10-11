"""Research skills reach both chat paths without becoming paper evidence or writes."""

import asyncio
import json
import os
import unittest
import uuid
from unittest.mock import patch

import httpx

from backend import ai, app
from backend.db import connect
from backend.research_skills import load_research_skill
from review import test_translation_flow as flow
from review.test_tool_chat_contract import tool_result


class ResearchSkillsReview(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.config = patch.object(ai, "current_config", return_value=("https://example.invalid/v1", "review-model", "review-key"))
        self.config.start()
        self.paper = app.import_pdf(str(flow.FIXTURES / "quartz_alpha.pdf"))["paper"]["id"]
        with connect() as db:
            db.execute("UPDATE papers SET source_language = 'zh', status = 'completed' WHERE id = ?", (self.paper,))

    def tearDown(self):
        self.config.stop()
        flow.TranslationFlowReview.tearDown(self)

    def test_loader_rejects_unknown_duplicate_and_non_string_names(self):
        for arguments in ({}, {"skills": []}, {"skills": ["unknown"]}, {"skills": [{}]},
                          {"skills": ["paper_close_reading"] * 2}, {"skills": ["paper_close_reading"], "path": "private"}):
            with self.subTest(arguments=arguments), self.assertRaises(ai.AIError):
                load_research_skill(arguments)

    def test_both_skills_available_with_search_on_or_off(self):
        for tools in (app.PAPER_TOOLS, app.LEGACY_PAPER_TOOLS):
            skill = next(tool for tool in tools if tool["function"]["name"] == "load_research_skill")
            self.assertEqual(set(skill["function"]["parameters"]["properties"]["skills"]["items"]["enum"]),
                             {"paper_close_reading", "scientific_critical_thinking"})

    def test_chat_loads_then_reads_evidence_without_writing(self):
        rounds = []

        def completion(messages, **kwargs):
            rounds.append(json.loads(json.dumps(messages)))
            if len(rounds) == 1:
                return tool_result("load_research_skill", {"skills": ["paper_close_reading", "scientific_critical_thinking"]})
            if len(rounds) == 2:
                self.assertIn("未报告", messages[-1]["content"])
                return tool_result("read_paper", {"start_page": 1, "end_page": 1})
            evidence = json.loads(messages[-1]["content"])
            self.assertIn("Quartz", evidence["excerpts"][0]["text"])
            return {"content": "研究解释：已核对原文。" + evidence["excerpts"][0]["citation"], "usage": None}

        with patch.object(ai, "chat_completion", side_effect=completion), patch.object(app, "prepare_note_action") as note, patch.object(app, "prepare_annotation_action") as annotation:
            result = asyncio.run(app.chat(self.paper, app.ChatInput(question="精读方法并评价证据")))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(rounds), 3)
        self.assertEqual(len(result["sources"]), 1)
        self.assertEqual(result["sources"][0]["start_page"], 1)
        note.assert_not_called()
        annotation.assert_not_called()

    def test_stream_loads_skill_and_reports_visible_tool_step(self):
        rounds = []

        async def stream(messages, **kwargs):
            rounds.append(json.loads(json.dumps(messages)))
            if len(rounds) == 1:
                yield {"type": "result", "result": tool_result("load_research_skill", {"skills": ["scientific_critical_thinking"]})}
            else:
                self.assertIn("相关与因果", messages[-1]["content"])
                yield {"type": "result", "result": {"content": "请先明确需要评价的主张。", "usage": None}}

        async def request():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url="http://test", headers={"Authorization": "Bearer research-test"}) as client:
                return await client.post(f"/papers/{self.paper}/chat/stream", json={"question": "如何判断证据是否充分", "web_search": False, "request_id": uuid.uuid4().hex})

        with patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "research-test"}), patch.object(ai, "stream_chat_completion", side_effect=stream):
            response = asyncio.run(request())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('"tool": "load_research_skill"', response.text)
        self.assertIn("event: done", response.text)
        self.assertNotIn("event: error", response.text)
        self.assertEqual(len(rounds), 2)

    def test_full_summary_keeps_reading_methods_and_original_text(self):
        def completion(messages, **kwargs):
            self.assertIn("论文精读", messages[0]["content"])
            self.assertIn("未报告", messages[0]["content"])
            self.assertIn("QUARTZ", messages[1]["content"])
            self.assertNotIn("tools", kwargs)
            return {"content": "全文已阅读。", "usage": None}

        with patch.object(ai, "chat_completion", side_effect=completion):
            result = asyncio.run(app.start_summary(self.paper, "全文精读并评价结论"))
        self.assertEqual(result["status"], "completed")

    def test_unrelated_chat_still_needs_only_one_request(self):
        with patch.object(ai, "chat_completion", return_value={"content": "4", "usage": None}) as completion, patch.object(app, "load_research_skill") as loader:
            result = asyncio.run(app.chat(self.paper, app.ChatInput(question="2+2是多少")))
        self.assertEqual(result["answer"], "4")
        self.assertEqual(completion.call_count, 1)
        loader.assert_not_called()
