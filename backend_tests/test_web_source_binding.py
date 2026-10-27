"""Only cited web evidence belongs to an answer, including legacy history."""
import asyncio
import json
import os
import shutil
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from reportlab.pdfgen import canvas

from backend import ai, app
from backend.db import connect, initialize

PAPER_SOURCE = {"id": "S1", "start_page": 1, "end_page": 1}
WEB_SOURCES = {
    "W1": {"id": "W1", "kind": "web", "title": "Credit card bills", "url": "https://bank.test/cards", "start_page": 0, "end_page": 0},
    "W2": {"id": "W2", "kind": "web", "title": "Gene2vec original paper", "url": "https://journal.test/gene2vec", "start_page": 0, "end_page": 0},
}


class WebSourceBinding(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"WORKBENCH_DATA_DIR": self.temporary.name, "WORKBENCH_SESSION_TOKEN": "web-source-test"})
        self.environment.start()
        initialize()
        source = Path(self.temporary.name) / "gene2vec.pdf"
        pdf = canvas.Canvas(str(source))
        pdf.drawString(40, 720, "A Synthetic Study of Gene Expression Embedding")
        pdf.save()
        self.paper = app.import_pdf(str(source))["paper"]["id"]
        folder = app.pdf_path(app.require_paper(self.paper)).parent
        for name in ("fixture-mono.pdf", "fixture-dual.pdf"):
            shutil.copyfile(source, folder / name)
        with connect() as db:
            db.execute("UPDATE papers SET status='completed', mono_pdf_file_name='fixture-mono.pdf', dual_pdf_file_name='fixture-dual.pdf' WHERE id=?", (self.paper,))
        self.session = app.ensure_chat_session(self.paper, None)["id"]

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def request(self, method, route, body=None):
        async def call():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url="http://test", headers={"Authorization": "Bearer web-source-test"}) as client:
                return await client.request(method, route, json=body)
        return asyncio.run(call())

    def seed(self, text="According to the paper [S1]."):
        app.add_chat_message(self.paper, "user", "How was gene2vec constructed?", session_id=self.session)
        return app.add_chat_message(self.paper, "assistant", text, sources=[PAPER_SOURCE, *WEB_SOURCES.values()], session_id=self.session)

    def test_paper_only_answer_has_no_uncited_web_sources(self):
        text = "The answer comes from the paper [S1]."
        answer, sources = app.stream_source_validation(text, {"S1": PAPER_SOURCE}, WEB_SOURCES)
        self.assertEqual(answer, text)
        self.assertEqual(sources, [PAPER_SOURCE])

    def test_real_web_citations_are_deduplicated_and_unknown_ids_marked(self):
        answer, sources = app.stream_source_validation("Original work [W2], again [W2], invalid [W9].", {}, WEB_SOURCES)
        self.assertEqual(sources, [WEB_SOURCES["W2"]])
        self.assertIn("〔未验证来源〕", answer)
        self.assertNotIn("[W9]", answer)

    def test_legacy_history_is_filtered_on_read_without_changing_saved_records(self):
        self.seed()
        self.seed("Original research [W2], paper [S1].")
        with connect() as db:
            before = [tuple(row) for row in db.execute("SELECT id, content, sources_json FROM chat_messages WHERE paper_id = ? ORDER BY id", (self.paper,))]
        response = self.request("GET", f"/papers/{self.paper}/chat?session_id={self.session}")
        self.assertEqual(response.status_code, 200, response.text)
        assistants = [message for message in response.json() if message["role"] == "assistant"]
        self.assertEqual(assistants[0]["sources"], [PAPER_SOURCE])
        self.assertEqual(assistants[1]["sources"], [PAPER_SOURCE, WEB_SOURCES["W2"]])
        with connect() as db:
            after = [tuple(row) for row in db.execute("SELECT id, content, sources_json FROM chat_messages WHERE paper_id = ? ORDER BY id", (self.paper,))]
        self.assertEqual(after, before)

    def stream(self, text, *, no_results=False, search=None):
        turns = []
        async def generate(messages, **kwargs):
            turns.append(list(messages))
            if (no_results or search) and len(turns) == 1:
                call = {"id": "search-gene2vec", "type": "function", "function": {"name": "web_search", "arguments": '{"query":"gene2vec original paper"}'}}
                yield {"type": "result", "result": {"content": "", "tool_calls": [call]}}
            else:
                yield {"type": "result", "result": {"content": text, "tool_calls": []}}
        with patch.object(ai, "current_config", return_value=("https://gateway.test/v1", "test-model", "test-key")), \
             patch.object(ai, "current_protocol", return_value="openai_chat_completions"), \
             patch.object(ai, "stream_chat_completion", side_effect=generate), \
             patch.object(app, "web_search_rss", side_effect=search, return_value=[]):
            response = self.request("POST", f"/papers/{self.paper}/chat/stream", {"question": "Explain gene2vec", "session_id": self.session, "request_id": "d" * 32, "web_search": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("event: done", response.text)
        return turns, self.request("GET", f"/papers/{self.paper}/chat?session_id={self.session}").json()[-1]

    def test_uncited_historical_web_result_cannot_be_reused_as_verified_evidence(self):
        self.seed()
        _, answer = self.stream("Paper [S1], stale web claim [W1].")
        self.assertIn("〔未验证来源〕", answer["content"])
        self.assertEqual(answer["sources"], [PAPER_SOURCE])

    def test_genuinely_cited_history_can_still_support_followup(self):
        self.seed("Paper [S1], original publication [W2].")
        _, answer = self.stream("Refer to the same publication [W2].")
        self.assertEqual(answer["sources"], [WEB_SOURCES["W2"]])
        self.assertNotIn("〔未验证来源〕", answer["content"])

    def test_no_relevant_search_results_do_not_abort_paper_answer(self):
        self.seed()
        turns, answer = self.stream("The paper explains this [S1].", no_results=True)
        self.assertEqual(answer["sources"], [PAPER_SOURCE])
        tool = next(message for message in turns[-1] if message["role"] == "tool")
        self.assertEqual(json.loads(tool["content"])["status"], "no_relevant_results")
        self.assertEqual(json.loads(tool["content"])["results"], [])

    def test_new_results_do_not_overwrite_sparse_cited_history_ids(self):
        self.seed("Original publication [W2].")
        async def search(query, first_result):
            self.assertEqual(first_result, 3)
            return [{**WEB_SOURCES["W2"], "id": f"W{first_result}", "url": "https://journal.test/new-paper"}]
        _, answer = self.stream("Earlier work [W2], new work [W3].", search=search)
        self.assertEqual([source["id"] for source in answer["sources"]], ["W2", "W3"])
        self.assertEqual(answer["sources"][0]["url"], WEB_SOURCES["W2"]["url"])
        self.assertEqual(answer["sources"][1]["url"], "https://journal.test/new-paper")


if __name__ == "__main__":
    unittest.main()
