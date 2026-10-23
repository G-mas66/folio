"""Paper favorites remain independent of bibliography and survive database reopen."""
import asyncio
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx

from backend import app
from backend.db import connect, initialize


class PaperFavoritesReview(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {
            "WORKBENCH_DATA_DIR": self.temporary.name,
            "WORKBENCH_SESSION_TOKEN": "paper-favorites-test",
        })
        self.environment.start()
        initialize()
        self.alpha, self.beta = "a" * 32, "b" * 32
        with connect() as db:
            db.execute("INSERT INTO folders(id, name, created_at) VALUES ('folder', '测试分类', '2026-01-01')")
            for paper_id, title, folder in [(self.alpha, "Alpha paper", "folder"), (self.beta, "Beta paper", None)]:
                db.execute(
                    "INSERT INTO papers(id, source_hash, source_name, file_name, english_title, page_count, status, created_at, updated_at, folder_id) "
                    "VALUES (?, ?, ?, 'original.pdf', ?, 1, 'needs_title', '2026-01-01', '2026-01-01', ?)",
                    (paper_id, paper_id, title + ".pdf", title, folder),
                )

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def request(self, method, path, body=None, token="paper-favorites-test"):
        async def call():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url="http://test", headers={"Authorization": f"Bearer {token}"}) as client:
                return await client.request(method, path, json=body)
        return asyncio.run(call())

    def favorite(self, paper_id, value):
        response = self.request("PATCH", f"/papers/{paper_id}/favorite", {"is_favorite": value})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["is_favorite"], value)

    def ids(self, query=""):
        response = self.request("GET", "/papers?" + query)
        self.assertEqual(response.status_code, 200, response.text)
        return {paper["id"] for paper in response.json()}

    def test_favorite_persists_after_initialize_and_unfavorite_removes_from_filter(self):
        self.assertFalse(self.request("GET", f"/papers/{self.alpha}").json()["is_favorite"])
        self.favorite(self.alpha, True)
        initialize()
        self.assertTrue(self.request("GET", f"/papers/{self.alpha}").json()["is_favorite"])
        self.assertEqual(self.ids("favorite=true"), {self.alpha})
        self.assertEqual(self.ids(), {self.alpha, self.beta})
        self.favorite(self.alpha, False)
        initialize()
        self.assertEqual(self.ids("favorite=true"), set())
        self.assertEqual(self.ids(), {self.alpha, self.beta})

    def test_favorites_combine_with_search_and_folder_filters(self):
        self.favorite(self.alpha, True)
        self.favorite(self.beta, True)
        self.assertEqual(self.ids("favorite=true&q=Alpha"), {self.alpha})
        self.assertEqual(self.ids("favorite=true&folder_id=folder"), {self.alpha})
        self.assertEqual(self.ids("favorite=true&folder_id=unfiled&q=Beta"), {self.beta})
        self.assertEqual(self.ids("favorite=true&folder_id=folder&q=Beta"), set())

    def test_legacy_migration_preserves_paper_and_reading_position(self):
        with connect() as db:
            db.execute("UPDATE papers SET last_page=7 WHERE id=?", (self.alpha,))
            db.execute("ALTER TABLE papers DROP COLUMN is_favorite")
        initialize()
        paper = self.request("GET", f"/papers/{self.alpha}").json()
        self.assertFalse(paper["is_favorite"])
        self.assertEqual((paper["english_title"], paper["last_page"], paper["folder_id"]), ("Alpha paper", 7, "folder"))
        self.assertEqual(self.ids(), {self.alpha, self.beta})

    def test_deleting_favorite_removes_record_and_its_library_copy(self):
        folder = Path(self.temporary.name) / "papers" / self.alpha
        folder.mkdir(parents=True)
        (folder / "original.pdf").write_bytes(b"test local copy")
        self.favorite(self.alpha, True)
        response = self.request("DELETE", f"/papers/{self.alpha}")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(folder.exists())
        self.assertEqual(self.ids("favorite=true"), set())
        self.assertEqual(self.request("GET", f"/papers/{self.alpha}").status_code, 404)
        self.assertEqual(self.ids(), {self.beta})

    def test_missing_invalid_and_unauthorized_requests_do_not_change_favorites(self):
        path = f"/papers/{self.alpha}/favorite"
        self.assertEqual(self.request("PATCH", "/papers/missing/favorite", {"is_favorite": True}).status_code, 404)
        self.assertEqual(self.request("PATCH", path, {}).status_code, 422)
        self.assertEqual(self.request("PATCH", path, {"is_favorite": True}, token="wrong").status_code, 401)
        self.assertEqual(self.ids("favorite=true"), set())


if __name__ == "__main__":
    unittest.main()
