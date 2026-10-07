"""Paper-scoped chat sessions and legacy-history migration."""

import asyncio
import os
import sqlite3
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx

from backend import app
from backend.db import connect, initialize
from review import test_translation_flow as flow


class ChatSessionsContract(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.token = patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "session-review-token"})
        self.token.start()
        self.first = app.import_pdf(str(flow.FIXTURES / "quartz_alpha.pdf"))["paper"]["id"]
        self.second = app.import_pdf(str(flow.FIXTURES / "quartz_beta_same_title.pdf"))["paper"]["id"]

    def tearDown(self):
        self.token.stop()
        flow.TranslationFlowReview.tearDown(self)

    def request(self, method, path, body=None, token="session-review-token"):
        async def call():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app.app), base_url="http://test",
                headers={"Authorization": f"Bearer {token}"},
            ) as client:
                return await client.request(method, path, json=body)
        return asyncio.run(call())

    def sessions(self, paper=None):
        response = self.request("GET", f"/papers/{paper or self.first}/chat-sessions")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_default_and_new_session_messages_are_isolated(self):
        default = self.sessions()[0]
        self.assertTrue(default["id"])
        self.assertEqual(default["title"], "对话 1")
        other = self.request("POST", f"/papers/{self.first}/chat-sessions").json()
        self.assertEqual(other["title"], "对话 2")
        app.add_chat_message(self.first, "user", "default only", session_id=default["id"])
        app.add_chat_message(self.first, "user", "second only", session_id=other["id"])
        self.assertEqual([item["content"] for item in self.request("GET", f"/papers/{self.first}/chat?session_id={default['id']}").json()], ["default only"])
        self.assertEqual([item["content"] for item in self.request("GET", f"/papers/{self.first}/chat?session_id={other['id']}").json()], ["second only"])

    def test_session_ids_cannot_cross_papers(self):
        first_session = self.sessions(self.first)[0]["id"]
        response = self.request("GET", f"/papers/{self.second}/chat?session_id={first_session}")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.request("DELETE", f"/papers/{self.second}/chat-sessions/{first_session}").status_code, 404)

    def test_delete_active_streaming_session_returns_conflict(self):
        session = self.sessions()[0]
        app.add_chat_message(self.first, "assistant", "partial", status="streaming", session_id=session["id"])
        response = self.request("DELETE", f"/papers/{self.first}/chat-sessions/{session['id']}")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(len(self.sessions()), 1)

    def test_delete_session_cascades_only_its_history_and_run(self):
        sessions = self.sessions()
        default_id = sessions[0]["id"]
        other = self.request("POST", f"/papers/{self.first}/chat-sessions").json()
        app.add_chat_message(self.first, "user", "delete me", session_id=default_id)
        app.add_chat_message(self.first, "user", "keep me", session_id=other["id"])
        with connect() as db:
            db.execute(
                "INSERT INTO analysis_runs(id,paper_id,kind,question,status,session_id,created_at,updated_at) VALUES(?,?, 'full_prompt','delete me','completed',?,?,?)",
                (uuid.uuid4().hex, self.first, default_id, app.now(), app.now()),
            )
        response = self.request("DELETE", f"/papers/{self.first}/chat-sessions/{default_id}")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["replacement"])
        self.assertEqual([item["content"] for item in self.request("GET", f"/papers/{self.first}/chat?session_id={other['id']}").json()], ["keep me"])
        with connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM chat_messages WHERE session_id = ?", (default_id,)).fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM analysis_runs WHERE session_id = ?", (default_id,)).fetchone()[0], 0)

    def test_delete_last_session_creates_an_empty_default(self):
        current = self.sessions()[0]
        response = self.request("DELETE", f"/papers/{self.first}/chat-sessions/{current['id']}")
        self.assertEqual(response.status_code, 200, response.text)
        replacement = response.json()["replacement"]
        self.assertTrue(replacement["id"])
        self.assertEqual(replacement["title"], "对话 1")
        self.assertEqual(self.sessions()[0]["id"], replacement["id"])
        self.assertEqual(self.request("GET", f"/papers/{self.first}/chat").json(), [])

    def test_missing_session_parameter_uses_default_for_old_clients(self):
        default = self.sessions()[0]
        app.add_chat_message(self.first, "user", "legacy request")
        self.assertEqual(self.request("GET", f"/papers/{self.first}/chat").json()[0]["content"], "legacy request")
        self.assertEqual(len(self.sessions()), 1)
        self.assertEqual(default["id"], self.sessions()[0]["id"])

    def test_old_database_history_and_analysis_migrate_into_default_session(self):
        root = Path(os.environ["WORKBENCH_DATA_DIR"])
        database = root / "workbench.sqlite"
        db = sqlite3.connect(database)
        try:
            db.executescript(
                """
                DROP TABLE chat_messages;
                DROP TABLE analysis_runs;
                DROP TABLE chat_sessions;
                CREATE TABLE chat_messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, paper_id TEXT NOT NULL, role TEXT NOT NULL,
                    content TEXT NOT NULL, sources_json TEXT NOT NULL DEFAULT '[]', reasoning TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'completed', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
                );
                CREATE TABLE analysis_runs (
                    id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL,
                    status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', final_answer TEXT NOT NULL DEFAULT '',
                    sources_json TEXT NOT NULL DEFAULT '[]', model_snapshot TEXT NOT NULL DEFAULT '',
                    protocol_snapshot TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                """
            )
            db.execute("INSERT INTO chat_messages(paper_id,role,content,created_at) VALUES(?,?,?,?)", (self.first, "user", "legacy chat", app.now()))
            db.execute("INSERT INTO analysis_runs(id,paper_id,kind,question,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", ("legacy-run",self.first,"full_prompt","legacy summary","interrupted",app.now(),app.now()))
            db.commit()
        finally:
            db.close()
        initialize()
        sessions = self.sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/chat?session_id={sessions[0]['id']}").json()[0]["content"], "legacy chat")
        with connect() as db:
            run = db.execute("SELECT session_id FROM analysis_runs WHERE id='legacy-run'").fetchone()
            self.assertEqual(run["session_id"], sessions[0]["id"])


if __name__ == "__main__":
    unittest.main()
