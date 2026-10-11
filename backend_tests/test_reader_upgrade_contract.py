"""Persistence, attachment and reader-upgrade contracts."""

import asyncio
import base64
import copy
import io
import json
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException
from pypdf import PdfWriter

from backend import ai, app
from backend.db import connect, initialize
from review import test_translation_flow as flow


class ReaderUpgradeContract(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.token = patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "reader-upgrade-token"})
        self.token.start()
        self.first = app.import_pdf(str(flow.FIXTURES / "quartz_alpha.pdf"))["paper"]["id"]
        self.second = app.import_pdf(str(flow.FIXTURES / "quartz_beta_same_title.pdf"))["paper"]["id"]
        with connect() as db:
            db.execute("UPDATE papers SET source_language = 'zh', status = 'completed' WHERE id IN (?, ?)", (self.first, self.second))

    def tearDown(self):
        self.token.stop()
        flow.TranslationFlowReview.tearDown(self)

    def request(self, method, path, body=None):
        async def call():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": "Bearer reader-upgrade-token"},
            ) as client:
                return await client.request(method, path, json=body)
        return asyncio.run(call())

    def session(self, paper=None):
        return self.request("GET", f"/papers/{paper or self.first}/chat-sessions").json()[0]["id"]

    @staticmethod
    def pdf_bytes(page_count):
        writer = PdfWriter()
        for _ in range(page_count):
            writer.add_blank_page(width=300, height=400)
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()

    @staticmethod
    def page_image(page_no, data=b"\xff\xd8\xff\xd9"):
        return {"page_no": page_no, "mime_type": "image/jpeg", "data_base64": base64.b64encode(data).decode("ascii")}

    def upload(self, session_id, content, *, name="attachment.pdf", mime_type="application/pdf", page_images=None):
        return self.request("POST", f"/papers/{self.first}/chat-sessions/{session_id}/attachments", {
            "name": name,
            "mime_type": mime_type,
            "data_base64": base64.b64encode(content).decode("ascii"),
            "page_images": page_images or [],
        })

    def test_legacy_note_and_reader_columns_migrate_idempotently(self):
        legacy_text = "旧版数据库中的笔记正文"
        with connect() as db:
            db.execute(
                "INSERT INTO paper_notes(paper_id, text, updated_at) VALUES (?, ?, 'legacy-time')",
                (self.first, legacy_text),
            )
            for table, column in (
                ("chat_messages", "attachments_json"),
                ("chat_attachments", "page_images_json"),
                ("paper_annotations", "view_contexts_json"),
                ("paper_annotations", "segment_anchor_json"),
            ):
                db.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
            db.execute("DROP TABLE paper_note_state")
            db.execute("DROP TABLE paper_note_tabs")

        initialize()
        initialize()
        notes = self.request("GET", f"/papers/{self.first}/notes").json()
        self.assertEqual(notes["text"], legacy_text)
        self.assertEqual(notes["notes"][0]["title"], "笔记 1")
        with connect() as db:
            for table, column in (
                ("chat_messages", "attachments_json"),
                ("chat_attachments", "page_images_json"),
                ("paper_annotations", "view_contexts_json"),
                ("paper_annotations", "segment_anchor_json"),
            ):
                names = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
                self.assertIn(column, names)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM paper_note_tabs WHERE paper_id = ?", (self.first,)).fetchone()[0], 1)

    def test_pdf_page_images_require_complete_unique_pages_and_stay_session_scoped(self):
        session_id = self.session()
        other_session = self.request("POST", f"/papers/{self.first}/chat-sessions").json()["id"]
        content = self.pdf_bytes(2)
        valid = [self.page_image(2), self.page_image(1)]
        uploaded = self.upload(session_id, content, page_images=valid)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        attachment_id = uploaded.json()["id"]
        self.assertEqual(uploaded.json()["page_count"], 2)
        with connect() as db:
            saved = json.loads(db.execute("SELECT page_images_json FROM chat_attachments WHERE id = ?", (attachment_id,)).fetchone()[0])
        self.assertEqual([image["page_no"] for image in saved], [1, 2])

        for images, status in (
            ([self.page_image(1)], 422),
            ([self.page_image(1), self.page_image(1)], 422),
            ([{**self.page_image(1), "mime_type": "image/png"}, self.page_image(2)], 415),
            ([self.page_image(1, b"not jpeg"), self.page_image(2)], 415),
        ):
            with self.subTest(images=images):
                self.assertEqual(self.upload(session_id, content, page_images=images).status_code, status)

        content_url = f"/papers/{self.first}/chat-sessions/{other_session}/attachments/{attachment_id}/content"
        self.assertEqual(self.request("GET", content_url).status_code, 404)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/chat-sessions/{other_session}/attachments").json(), [])
        response = self.request("POST", f"/papers/{self.first}/chat/stream", {
            "question": "查看附件", "session_id": other_session, "attachment_ids": [attachment_id],
            "request_id": "1" * 32, "web_search": False,
        })
        self.assertEqual(response.status_code, 404, response.text)

    def test_sync_and_stream_chat_rebuild_historical_image_attachments(self):
        data = b"\xff\xd8\xff\xd9"
        image_base64 = base64.b64encode(data).decode("ascii")

        sync_session = self.session()
        uploaded = self.upload(sync_session, data, name="figure.jpg", mime_type="image/jpeg")
        sync_calls = []

        def complete(messages, **kwargs):
            sync_calls.append(copy.deepcopy(messages))
            return {"content": "已收到图片。", "tool_calls": []}

        with patch.object(ai, "current_config", return_value=("https://gateway.test/v1", "test-model", "key")), \
             patch.object(ai, "current_protocol", return_value="openai_chat_completions"), \
             patch.object(ai, "chat_completion", side_effect=complete):
            first = self.request("POST", f"/papers/{self.first}/chat", {
                "question": "看这张图", "session_id": sync_session, "attachment_ids": [uploaded.json()["id"]],
            })
            second = self.request("POST", f"/papers/{self.first}/chat", {"question": "再说一次", "session_id": sync_session})
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertTrue(any(
            part.get("type") == "image_url" and part["image_url"]["url"] == f"data:image/jpeg;base64,{image_base64}"
            for message in sync_calls[1] if isinstance(message.get("content"), list)
            for part in message["content"]
        ))

        stream_session = self.request("POST", f"/papers/{self.first}/chat-sessions").json()["id"]
        streamed = self.upload(stream_session, data, name="figure.jpg", mime_type="image/jpeg")
        stream_calls = []

        async def stream(messages, **kwargs):
            stream_calls.append(copy.deepcopy(messages))
            yield {"type": "result", "result": {"content": "已收到图片。", "tool_calls": []}}

        with patch.object(ai, "current_config", return_value=("https://gateway.test/v1", "test-model", "key")), \
             patch.object(ai, "current_protocol", return_value="openai_chat_completions"), \
             patch.object(ai, "stream_chat_completion", side_effect=stream):
            first = self.request("POST", f"/papers/{self.first}/chat/stream", {
                "question": "看这张图", "session_id": stream_session, "attachment_ids": [streamed.json()["id"]],
                "request_id": "2" * 32, "web_search": False,
            })
            second = self.request("POST", f"/papers/{self.first}/chat/stream", {
                "question": "再说一次", "session_id": stream_session,
                "request_id": "3" * 32, "web_search": False,
            })
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertTrue(any(
            part.get("type") == "image_url" and part["image_url"]["url"] == f"data:image/jpeg;base64,{image_base64}"
            for message in stream_calls[1] if isinstance(message.get("content"), list)
            for part in message["content"]
        ))

    def test_pdf_text_extraction_limit_is_100000_characters_without_truncation(self):
        row = {
            "content": b"synthetic-pdf", "kind": "file", "mime_type": "application/pdf",
            "name": "long.pdf", "page_images_json": "[]",
        }
        with patch.object(app, "pdf_attachment_pages", return_value=["x" * 25000]):
            content = app.attachment_message_content("question", [row])
        self.assertTrue(any("x" * 25000 in part["text"] for part in content if part["type"] == "text"))
        with patch.object(app, "pdf_attachment_pages", return_value=["x" * 100001]), self.assertRaises(HTTPException) as caught:
            app.attachment_message_content("question", [row])
        self.assertEqual(caught.exception.status_code, 413)

    def test_responses_input_converts_chat_image_blocks(self):
        url = "data:image/jpeg;base64,/9j/2Q=="
        converted = ai._responses_input([{
            "role": "user",
            "content": [
                {"type": "text", "text": "检查图片"},
                {"type": "image_url", "image_url": {"url": url}},
            ],
        }])
        self.assertEqual(converted, [{
            "role": "user",
            "content": [
                {"type": "input_text", "text": "检查图片"},
                {"type": "input_image", "image_url": url},
            ],
        }])

    def test_chat_completion_accepts_explicit_finish_at_eof_only(self):
        tool = [{"type": "function", "function": {"name": "read_paper", "parameters": {"type": "object"}}}]

        def collect(finish_reason, delta):
            event = {"choices": [{"index": 0, "delta": delta}]}
            if finish_reason is not None:
                event["choices"][0]["finish_reason"] = finish_reason
            wire = b"data: " + json.dumps(event).encode("utf-8") + b"\n\n"
            original_client = httpx.AsyncClient

            def client_factory(*args, **kwargs):
                kwargs["transport"] = httpx.MockTransport(lambda request: httpx.Response(
                    200, headers={"content-type": "text/event-stream"}, content=wire,
                ))
                return original_client(*args, **kwargs)

            async def run():
                with patch.object(httpx, "AsyncClient", side_effect=client_factory), patch.object(ai, "_record_usage"):
                    return [item async for item in ai.stream_chat_completion(
                        [{"role": "user", "content": "hi"}], config=("https://provider.test/custom", "m", "key"),
                        protocol="custom_chat_completions", tools=tool if finish_reason == "tool_calls" else None,
                    )]
            return asyncio.run(run())

        stopped = collect("stop", {"content": "完整回答"})
        self.assertEqual(stopped[-1]["result"]["content"], "完整回答")
        tool_result = collect("tool_calls", {"tool_calls": [{
            "index": 0, "id": "call-1", "type": "function",
            "function": {"name": "read_paper", "arguments": "{}"},
        }]})
        self.assertEqual(tool_result[-1]["result"]["tool_calls"][0]["function"]["name"], "read_paper")
        for reason in (None, "length", "content_filter"):
            with self.subTest(reason=reason), self.assertRaises(ai.AIError):
                collect(reason, {"content": "未确认完成"})

    def test_real_view_page_counts_normalize_confirmation_and_invalidate_old_links(self):
        folder = app.pdf_path(app.require_paper(self.first)).parent
        for name, count in (("mono-two.pdf", 2), ("dual-three.pdf", 3), ("mono-rebuilt.pdf", 1), ("dual-rebuilt.pdf", 1)):
            (folder / name).write_bytes(self.pdf_bytes(count))
        with connect() as db:
            db.execute(
                "UPDATE papers SET mono_pdf_file_name = ?, dual_pdf_file_name = ? WHERE id = ?",
                ("mono-two.pdf", "dual-three.pdf", self.first),
            )
        paper = app.require_paper(self.first)
        self.assertEqual(app.pdf_view_page_count(paper, "mono"), 2)
        self.assertEqual(app.pdf_view_page_count(paper, "dual"), 3)

        rects = [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.02}]
        selection = {"pdf_kind": "mono", "page_no": 2, "rects": rects, "selected_text": "selected mono text"}
        normalized = app.normalize_paper_selection_context(selection, paper)
        action = app.prepare_annotation_action(
            paper, self.session(), None,
            {"question": "为什么？", "explanation": "说明", "quote": "selected mono text", "use_selection": True},
            normalized,
        )
        confirmed = self.request("POST", f"/papers/{self.first}/agent-actions/{action['id']}/confirm", {"comment": "已核对"})
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        saved = confirmed.json()["result"]["annotation"]
        self.assertEqual((saved["pdf_kind"], saved["page_no"], saved["selected_text"]), ("mono", 2, "selected mono text"))
        self.assertEqual(saved["rects"][0]["underline_edge"], "bottom")

        for kind, page_no in (("mono", 3), ("dual", 4)):
            response = self.request("POST", f"/papers/{self.first}/annotations", {
                "pdf_kind": kind, "page_no": page_no, "rects": rects, "selected_text": "out of range",
                "color": "yellow", "kind": "highlight",
            })
            self.assertEqual(response.status_code, 422, response.text)

        views = {
            "original": {"page_no": 1, "rects": rects, "selected_text": "original text"},
            "mono": {"page_no": 2, "rects": rects, "selected_text": "mono text"},
            "dual": {"page_no": 3, "rects": rects, "selected_text": "dual text"},
        }
        linked = self.request("POST", f"/papers/{self.first}/annotations", {
            "pdf_kind": "original", "page_no": 1, "rects": rects, "selected_text": "original text",
            "view_contexts": views, "comment": "cross-view", "color": "yellow", "kind": "comment",
        })
        self.assertEqual(linked.status_code, 200, linked.text)
        with connect() as db:
            db.execute(
                "UPDATE papers SET mono_pdf_file_name = ?, dual_pdf_file_name = ? WHERE id = ?",
                ("mono-rebuilt.pdf", "dual-rebuilt.pdf", self.first),
            )
            app.invalidate_rebuilt_annotation_views(db, self.first)
        after = next(item for item in self.request("GET", f"/papers/{self.first}/annotations").json() if item["id"] == linked.json()["id"])
        self.assertEqual(set(after["view_contexts"]), {"original"})
        self.assertEqual((after["pdf_kind"], after["page_no"], after["selected_text"]), ("original", 1, "original text"))


if __name__ == "__main__":
    unittest.main()
