"""Focused deep-research coverage tests using synthetic text and a stub model."""

import asyncio
import json
import os
import sqlite3
import threading
import unittest
import uuid
from contextlib import contextmanager
from unittest.mock import patch

import httpx

from backend import ai, app, research_agent
from backend.db import connect
from review import test_translation_flow as flow


def tool_result(name, arguments=None, call_id="research_call"):
    calls = [{
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments or {})},
    }]
    return {
        "content": "",
        "tool_calls": calls,
        "message": {"role": "assistant", "content": None, "tool_calls": calls},
        "usage": None,
    }


class ResearchAgentContract(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.config = patch.object(ai, "current_config", return_value=("https://example.invalid/v1", "review-model", "review-key"))
        self.config.start()
        research_agent.initialize_research_tables()
        self.paper_id = uuid.uuid4().hex
        self.texts = [
            "SYNTHETIC_ALPHA evidence supports 42 units in the trial.",
            "SYNTHETIC_BETA follow-up confirms 17 records in the sample.",
        ]
        timestamp = app.now()
        with connect() as db:
            db.execute(
                "INSERT INTO papers(id, source_hash, source_name, file_name, english_title, source_language, title_confident, page_count, status, created_at, updated_at) "
                "VALUES (?, ?, 'synthetic.pdf', 'synthetic.pdf', 'Synthetic paper', 'en', 1, 1, 'completed', ?, ?)",
                (self.paper_id, self.paper_id, timestamp, timestamp),
            )
            db.execute(
                "INSERT INTO pages(paper_id, page_no, extraction_status, text_chars) VALUES (?, 1, 'text', ?)",
                (self.paper_id, sum(map(len, self.texts))),
            )
            db.executemany(
                "INSERT INTO segments(paper_id, sequence_no, start_page, end_page, original_text) VALUES (?, ?, 1, 1, ?)",
                [(self.paper_id, index, text) for index, text in enumerate(self.texts, 1)],
            )
            self.segment_ids = [row[0] for row in db.execute(
                "SELECT id FROM segments WHERE paper_id = ? ORDER BY sequence_no", (self.paper_id,)
            ).fetchall()]

    def tearDown(self):
        self.config.stop()
        flow.TranslationFlowReview.tearDown(self)

    def test_gpt_decimal_versions_are_recognized_as_vision_models(self):
        for model in ("gpt-4o", "gpt-4.1", "gpt-5", "gpt-5.1", "gpt-5.2", "gpt-6.1", "openai/gpt-5.2-mini"):
            with self.subTest(model=model):
                self.assertTrue(research_agent.supports_vision(model))
        for model in ("gpt-5x", "mygpt-5.1", "custom-text-model"):
            with self.subTest(model=model):
                self.assertFalse(research_agent.supports_vision(model))

    def test_one_segment_does_not_count_as_full_page_coverage(self):
        timestamp = app.now()
        scope = {"kind": "question", "expected_pages": None}
        with connect() as db:
            db.execute(
                "INSERT INTO research_tasks(id, paper_id, question, model, scope_json, status, created_at, updated_at) "
                "VALUES ('partial-segment-task', ?, 'synthetic question', 'review-model', ?, 'running', ?, ?)",
                (self.paper_id, json.dumps(scope), timestamp, timestamp),
            )
            db.execute(
                "INSERT INTO research_evidence(task_id, source_id, kind, start_page, end_page, text, metadata_json) "
                "VALUES ('partial-segment-task', ?, 'paper', 1, 1, ?, ?)",
                (f"S{self.segment_ids[0]}", self.texts[0], json.dumps({"segment_complete": True})),
            )
            row = db.execute("SELECT * FROM research_tasks WHERE id = 'partial-segment-task'").fetchone()
            partial = research_agent._task_view(db, row)
            scope["kind"] = "full"
            scope["expected_pages"] = [1]
            scope["expected_segments"] = {"1": [f"S{item}" for item in self.segment_ids]}
            db.execute("UPDATE research_tasks SET scope_json = ? WHERE id = 'partial-segment-task'", (json.dumps(scope),))
            row = db.execute("SELECT * FROM research_tasks WHERE id = 'partial-segment-task'").fetchone()
            full = research_agent._task_view(db, row)

        self.assertEqual(partial["coverage"]["text_pages"], [])
        self.assertIsNone(partial["coverage"]["percent"])
        self.assertEqual(full["coverage"]["covered_pages"], [])
        self.assertFalse(full["coverage"]["complete"])
        self.assertEqual(full["coverage"]["percent"], 0)

    def test_first_model_call_reads_persisted_question_and_all_page_segments(self):
        calls = []
        question = "请全文研究这些合成证据"
        answer = "SYNTHETIC_ALPHA evidence supports 42 units; SYNTHETIC_BETA follow-up confirms 17 records [S1] [S2]"
        valid_claims = [
            {"claim": "SYNTHETIC_ALPHA evidence supports 42 units", "support": [
                {"source_id": "S1", "quote": self.texts[0]},
            ]},
            {"claim": "SYNTHETIC_BETA follow-up confirms 17 records", "support": [
                {"source_id": "S2", "quote": self.texts[1]},
            ]},
        ]
        invalid_claims = [
            {"claim": "SYNTHETIC_ALPHA evidence supports 42 units", "support": [
                {"source_id": "S1", "quote": "quotation absent from source"},
            ]},
            valid_claims[1],
        ]

        def completion(messages, **kwargs):
            calls.append(json.loads(json.dumps(messages)))
            if len(calls) == 1:
                return tool_result("read_paper", {}, "read-synthetic")
            if len(calls) == 2:
                read_result = json.loads(messages[-1]["content"])
                self.assertEqual({item["source_id"] for item in read_result["excerpts"]}, {"S1", "S2"})
                self.assertTrue(read_result["coverage_complete"])
                return tool_result("submit_research_answer", {"answer": answer, "claims": invalid_claims}, "bad-quote")
            if len(calls) == 3:
                verification = json.loads(messages[-1]["content"])
                self.assertEqual(verification["status"], "rejected")
                self.assertIn("逐字", verification["message"])
                return tool_result("submit_research_answer", {"answer": answer, "claims": valid_claims}, "valid-quote")
            raise AssertionError("unexpected model call")

        async def create_and_wait():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": "Bearer research-test"},
            ) as client:
                response = await client.post(
                    f"/papers/{self.paper_id}/research",
                    json={"question": question, "model": "gpt-5.1"},
                )
                self.assertEqual(response.status_code, 200, response.text)
                task_id = response.json()["task"]["id"]
                worker = research_agent.ACTIVE_TASKS.get(task_id)
                if worker:
                    await worker
                final = await client.get(f"/papers/{self.paper_id}/research/{task_id}")
                return task_id, final

        with patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "research-test"}), patch.object(ai, "chat_completion", side_effect=completion):
            task_id, response = asyncio.run(create_and_wait())

        self.assertEqual(response.status_code, 200, response.text)
        task = response.json()["task"]
        self.assertEqual(task["status"], "completed", task["error"])
        self.assertEqual(task["coverage"]["covered_pages"], [1])
        self.assertEqual(len(calls), 3)
        self.assertEqual([message["role"] for message in calls[0][:2]], ["system", "user"])
        self.assertIn(question, calls[0][1]["content"])
        with connect() as db:
            saved = db.execute("SELECT messages_json, scope_json FROM research_tasks WHERE id = ?", (task_id,)).fetchone()
        self.assertIn(question, saved["messages_json"])
        self.assertEqual(saved["scope_json"] and json.loads(saved["scope_json"])["expected_segments"]["1"], [f"S{item}" for item in self.segment_ids])

    def test_research_helpers_are_safe_when_tables_are_absent(self):
        @contextmanager
        def empty_database():
            connection = sqlite3.connect(":memory:")
            try:
                yield connection
            finally:
                connection.close()

        with patch.object(research_agent, "connect", empty_database):
            self.assertFalse(research_agent.research_session_is_active("synthetic-session"))
            asyncio.run(research_agent.cancel_research_for_paper(self.paper_id))

    def test_stop_resume_waiting_for_image_restarts_timeout(self):
        calls = []

        def completion(messages, **kwargs):
            calls.append(json.loads(json.dumps(messages)))
            if len(calls) == 1:
                return tool_result("read_page_image", {"page_no": 1}, "read-image")
            self.assertIn("超时", messages[-1]["content"])
            return tool_result("submit_research_answer", {
                "answer": "页面图像没有返回，本次未核验视觉内容。", "claims": [],
            }, "answer-after-timeout")

        async def stop_resume_and_expire():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": "Bearer research-test"},
            ) as client:
                created = await client.post(
                    f"/papers/{self.paper_id}/research",
                    json={"question": "请检查图表趋势", "model": "gpt-5.1"},
                )
                self.assertEqual(created.status_code, 200, created.text)
                task_id = created.json()["task"]["id"]
                initial_worker = research_agent.ACTIVE_TASKS[task_id]
                await initial_worker

                stopped = await client.post(f"/papers/{self.paper_id}/research/{task_id}/stop")
                self.assertEqual(stopped.json()["task"]["status"], "stopped")
                self.assertTrue(initial_worker.done())
                resumed = await client.post(f"/papers/{self.paper_id}/research/{task_id}/resume")
                self.assertEqual(resumed.status_code, 200, resumed.text)
                self.assertEqual(resumed.json()["status"], "waiting_for_image")
                timeout = research_agent.IMAGE_TIMEOUTS[task_id]
                await timeout
                worker = research_agent.ACTIVE_TASKS.get(task_id)
                if worker:
                    await worker
                final = await client.get(f"/papers/{self.paper_id}/research/{task_id}")
                return task_id, final

        with patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "research-test"}), \
             patch.object(research_agent, "MAX_IMAGE_WAIT_SECONDS", 0.1), \
             patch.object(ai, "chat_completion", side_effect=completion):
            task_id, response = asyncio.run(stop_resume_and_expire())

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["task"]["status"], "partial", response.json()["task"]["error"])
        self.assertEqual(response.json()["task"]["answer"], research_agent.INSUFFICIENT_EVIDENCE_ANSWER)
        self.assertEqual(len(calls), 2)
        with connect() as db:
            request = db.execute("SELECT status FROM research_image_requests WHERE task_id = ?", (task_id,)).fetchone()
        self.assertEqual(request["status"], "timed_out")

    def test_immediate_stop_resume_replaces_cancelled_worker(self):
        entered = threading.Event()
        release = threading.Event()
        lock = threading.Lock()
        call_count = 0

        def completion(messages, **kwargs):
            nonlocal call_count
            with lock:
                call_count += 1
                current_call = call_count
            if current_call == 1:
                entered.set()
                release.wait(3)
            return tool_result("submit_research_answer", {
                "answer": "目前没有可支持的实证结论。", "claims": [],
            }, f"answer-{current_call}")

        async def stop_and_resume_immediately():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": "Bearer research-test"},
            ) as client:
                created = await client.post(
                    f"/papers/{self.paper_id}/research",
                    json={"question": "请总结可用证据", "model": "review-model"},
                )
                self.assertEqual(created.status_code, 200, created.text)
                task_id = created.json()["task"]["id"]
                self.assertTrue(await asyncio.to_thread(entered.wait, 2), "model call did not start")
                old_worker = research_agent.ACTIVE_TASKS[task_id]
                stopped = await client.post(f"/papers/{self.paper_id}/research/{task_id}/stop")
                self.assertEqual(stopped.json()["task"]["status"], "stopped")
                self.assertTrue(old_worker.done(), "stop returned before the old worker exited")
                resumed = await client.post(f"/papers/{self.paper_id}/research/{task_id}/resume")
                self.assertEqual(resumed.status_code, 200, resumed.text)
                release.set()
                for _ in range(100):
                    final = await client.get(f"/papers/{self.paper_id}/research/{task_id}")
                    if final.json()["task"]["status"] in {"completed", "failed", "stopped", "interrupted"}:
                        break
                    await asyncio.sleep(0.01)
                return final

        try:
            with patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "research-test"}), \
                 patch.object(ai, "chat_completion", side_effect=completion):
                response = asyncio.run(stop_and_resume_immediately())
        finally:
            release.set()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["task"]["status"], "partial", response.json()["task"]["error"])
        self.assertEqual(response.json()["task"]["answer"], research_agent.INSUFFICIENT_EVIDENCE_ANSWER)
        self.assertEqual(call_count, 2)

    def test_resume_waits_for_worker_while_stop_request_is_still_cancelling_it(self):
        task_id = uuid.uuid4().hex
        timestamp = app.now()
        with connect() as db:
            db.execute(
                "INSERT INTO research_tasks(id, paper_id, question, model, scope_json, status, budget_json, created_at, updated_at) "
                "VALUES (?, ?, 'concurrent stop resume', 'review-model', ?, 'running', '{}', ?, ?)",
                (task_id, self.paper_id, json.dumps({"kind": "question", "expected_pages": None}), timestamp, timestamp),
            )
        model_started = threading.Event()

        def completion(messages, **kwargs):
            model_started.set()
            return tool_result("submit_research_answer", {
                "answer": "目前没有可支持的实证结论。", "claims": [],
            }, "resumed-answer")

        async def issue_overlapping_requests():
            cancel_entered = asyncio.Event()
            release_old_worker = asyncio.Event()

            async def old_worker():
                try:
                    await asyncio.Future()
                except asyncio.CancelledError:
                    cancel_entered.set()
                    await release_old_worker.wait()
                    raise

            old_worker_task = asyncio.create_task(old_worker())
            research_agent.ACTIVE_TASKS[task_id] = old_worker_task
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": "Bearer research-test"},
            ) as client:
                stop_request = asyncio.create_task(client.post(f"/papers/{self.paper_id}/research/{task_id}/stop"))
                resume_request = None
                try:
                    await asyncio.wait_for(cancel_entered.wait(), timeout=2)
                    resume_request = asyncio.create_task(client.post(f"/papers/{self.paper_id}/research/{task_id}/resume"))
                    await asyncio.sleep(0.02)
                    self.assertFalse(resume_request.done(), "resume returned before the cancelled worker exited")
                    with connect() as db:
                        status_while_stopping = db.execute("SELECT status FROM research_tasks WHERE id = ?", (task_id,)).fetchone()["status"]
                    self.assertEqual(status_while_stopping, "stopped")
                finally:
                    release_old_worker.set()
                stopped, resumed = await asyncio.gather(stop_request, resume_request)
                self.assertTrue(old_worker_task.done())
                self.assertEqual(stopped.status_code, 200, stopped.text)
                self.assertEqual(resumed.status_code, 200, resumed.text)
                self.assertTrue(await asyncio.to_thread(model_started.wait, 2), "resumed worker did not reach the model")
                worker = research_agent.ACTIVE_TASKS.get(task_id)
                if worker and worker is not old_worker_task:
                    await worker
                final = await client.get(f"/papers/{self.paper_id}/research/{task_id}")
                return final

        with patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "research-test"}), \
             patch.object(ai, "chat_completion", side_effect=completion):
            response = asyncio.run(issue_overlapping_requests())

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["task"]["status"], "partial", response.json()["task"]["error"])
        self.assertEqual(response.json()["task"]["answer"], research_agent.INSUFFICIENT_EVIDENCE_ANSWER)

    def test_unclaimed_answer_tail_is_rejected(self):
        calls = []
        supported_claim = "SYNTHETIC_ALPHA evidence supports 42 units"
        answer_with_unclaimed_tail = supported_claim + "; additionally, the instrument recorded 17 groups [S1]"
        corrected_answer = "## 合成研究结果\n\n**" + supported_claim + "** [S1]"
        claims = [{"claim": supported_claim, "support": [{"source_id": "S1", "quote": self.texts[0]}]}]

        def completion(messages, **kwargs):
            calls.append(json.loads(json.dumps(messages)))
            if len(calls) == 1:
                return tool_result("read_paper", {}, "read-all")
            if len(calls) == 2:
                return tool_result("submit_research_answer", {
                    "answer": answer_with_unclaimed_tail, "claims": claims,
                }, "unclaimed-tail")
            verification = json.loads(messages[-1]["content"])
            self.assertEqual(verification["status"], "rejected")
            self.assertIn("未列入逐条核验", verification["message"])
            return tool_result("submit_research_answer", {"answer": corrected_answer, "claims": claims}, "covered-answer")

        async def create_and_wait():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": "Bearer research-test"},
            ) as client:
                created = await client.post(
                    f"/papers/{self.paper_id}/research",
                    json={"question": "请全文分析这些合成证据", "model": "review-model"},
                )
                self.assertEqual(created.status_code, 200, created.text)
                task_id = created.json()["task"]["id"]
                worker = research_agent.ACTIVE_TASKS.get(task_id)
                if worker:
                    await worker
                return await client.get(f"/papers/{self.paper_id}/research/{task_id}")

        with patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "research-test"}), patch.object(ai, "chat_completion", side_effect=completion):
            response = asyncio.run(create_and_wait())

        self.assertEqual(response.status_code, 200, response.text)
        task = response.json()["task"]
        self.assertEqual(task["status"], "completed", task["error"])
        self.assertEqual(task["answer"], corrected_answer)
        self.assertEqual(len(calls), 3)

    def test_unverified_answer_without_evidence_uses_fixed_partial_response(self):
        unsupported_answer = "The data proves 99."

        def completion(messages, **kwargs):
            return tool_result("submit_research_answer", {"answer": unsupported_answer, "claims": []}, "unsupported-answer")

        async def create_and_wait():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": "Bearer research-test"},
            ) as client:
                created = await client.post(
                    f"/papers/{self.paper_id}/research",
                    json={"question": "给出一条结论", "model": "review-model"},
                )
                self.assertEqual(created.status_code, 200, created.text)
                task_id = created.json()["task"]["id"]
                worker = research_agent.ACTIVE_TASKS.get(task_id)
                if worker:
                    await worker
                final = await client.get(f"/papers/{self.paper_id}/research/{task_id}")
                return task_id, final

        with patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "research-test"}), patch.object(ai, "chat_completion", side_effect=completion):
            task_id, response = asyncio.run(create_and_wait())

        self.assertEqual(response.status_code, 200, response.text)
        task = response.json()["task"]
        self.assertEqual(task["status"], "partial")
        self.assertEqual(task["answer"], research_agent.INSUFFICIENT_EVIDENCE_ANSWER)
        self.assertNotIn(unsupported_answer, task["answer"])
        with connect() as db:
            stored = db.execute("SELECT messages_json FROM research_tasks WHERE id = ?", (task_id,)).fetchone()["messages_json"]
        self.assertNotIn(unsupported_answer, stored)


if __name__ == "__main__":
    unittest.main()
