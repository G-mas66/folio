"""Independent checks for concurrent note edits and agent confirmation."""
import concurrent.futures
import unittest

from backend import app
from backend_tests import test_agent_actions as agent_contract


class ReaderUpgradeReview(unittest.TestCase):
    setUp = agent_contract.AgentActionsContract.setUp
    tearDown = agent_contract.AgentActionsContract.tearDown
    request = agent_contract.AgentActionsContract.request
    session = agent_contract.AgentActionsContract.session

    def test_editor_save_preserves_a_concurrent_rename(self):
        note = self.request("GET", f"/papers/{self.first}/notes").json()["notes"][0]
        renamed = self.request("PATCH", f"/papers/{self.first}/notes/{note['id']}", {"title": "方法记录"})
        self.assertEqual(renamed.status_code, 200, renamed.text)
        saved = self.request("PUT", f"/papers/{self.first}/notes/{note['id']}", {
            "text": "# 已保存\n\n方法解释", "expected_text": note["text"],
        })
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["title"], "方法记录")
        stale = self.request("PUT", f"/papers/{self.first}/notes/{note['id']}", {
            "text": "stale overwrite", "expected_text": note["text"],
        })
        self.assertEqual(stale.status_code, 409, stale.text)

    def test_simultaneous_confirmation_appends_once(self):
        note = self.request("GET", f"/papers/{self.first}/notes").json()["notes"][0]
        action = app.create_agent_action(self.first, self.session(), None, "note", {
            "text": "唯一追加内容", "note_id": note["id"],
        })
        def confirm(_):
            return self.request("POST", f"/papers/{self.first}/agent-actions/{action['id']}/confirm", {
                "note_id": note["id"], "expected_note_text": note["text"],
            })
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(confirm, range(2)))
        for response in results:
            self.assertEqual(response.status_code, 200, response.text)
        current = self.request("GET", f"/papers/{self.first}/notes").json()
        self.assertEqual(current["text"], "唯一追加内容")
        self.assertEqual(results[0].json()["result"], results[1].json()["result"])

    def test_agent_can_write_another_tab_without_switching_the_active_note(self):
        first = self.request("GET", f"/papers/{self.first}/notes").json()["notes"][0]
        second = self.request("POST", f"/papers/{self.first}/notes", {"title": "第二篇", "text": "保留正文"}).json()
        for selected in (first, second):
            selected_response = self.request("PATCH", f"/papers/{self.first}/notes/active", {"note_id": selected["id"]})
            self.assertEqual(selected_response.status_code, 200, selected_response.text)
        action = app.create_agent_action(self.first, self.session(), None, "note", {
            "text": "追加第一篇", "note_id": first["id"],
        })
        response = self.request("POST", f"/papers/{self.first}/agent-actions/{action['id']}/confirm", {
            "note_id": first["id"], "expected_note_text": first["text"],
        })
        self.assertEqual(response.status_code, 200, response.text)
        current = self.request("GET", f"/papers/{self.first}/notes").json()
        self.assertEqual(current["active_note_id"], second["id"])
        self.assertEqual(current["text"], "保留正文")
        self.assertEqual(next(note for note in current["notes"] if note["id"] == first["id"])["text"], "追加第一篇")
