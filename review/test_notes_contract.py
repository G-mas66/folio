"""Independent notes/annotation persistence, coordinate and isolation checks."""
import asyncio
import hashlib
import json
import os
import unittest
from unittest.mock import patch

import httpx
from backend import app
from backend.db import connect, initialize
from review import test_translation_flow as flow


class NotesReview(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.token = patch.dict(os.environ, {"WORKBENCH_SESSION_TOKEN": "notes-review-token"})
        self.token.start()
        self.first = app.import_pdf(str(flow.FIXTURES / "quartz_alpha.pdf"))["paper"]["id"]
        self.second = app.import_pdf(str(flow.FIXTURES / "quartz_beta_same_title.pdf"))["paper"]["id"]

    def tearDown(self):
        self.token.stop()
        flow.TranslationFlowReview.tearDown(self)

    def request(self, method, path, body=None, token="notes-review-token"):
        async def call():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url="http://test", headers={"Authorization": f"Bearer {token}"}) as client:
                return await client.request(method, path, json=body)
        return asyncio.run(call())

    def mark(self, paper=None, **updates):
        body = {"pdf_kind": "original", "page_no": 1, "kind": "highlight", "color": "yellow", "selected_text": "137 independent samples", "comment": "", "rects": [{"x": .1, "y": .2, "width": .3, "height": .02}, {"x": .1, "y": .225, "width": .2, "height": .02}]}
        body.update(updates)
        return self.request("POST", f"/papers/{paper or self.first}/annotations", body)

    def test_notes_unicode_save_reload_and_clear_without_changing_pdf(self):
        source = app.pdf_path(app.require_paper(self.first))
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], "")
        content = "# 阅读记录\n结论：样本 137；公式 $W_{ij}$。\n<script>alert(1)</script>\n"
        saved = self.request("PUT", f"/papers/{self.first}/notes", {"text": content})
        self.assertEqual(saved.status_code, 200, saved.text)
        initialize()
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], content)
        self.assertEqual(self.request("GET", f"/papers/{self.second}/notes").json()["text"], "")
        self.assertEqual(self.request("PUT", f"/papers/{self.first}/notes", {"text": ""}).status_code, 200)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], "")
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)

    def test_multiline_coordinates_versions_and_comment_persist(self):
        marks = []
        for kind in ("original", "mono", "dual"):
            response = self.mark(pdf_kind=kind, kind="comment", comment=f"{kind} 独立批注")
            self.assertEqual(response.status_code, 200, response.text)
            marks.append(response.json())
        underline = self.mark(kind="underline", rects=[
            {"x": .1, "y": .2, "width": .3, "height": .02, "underline_edge": "left"},
            {"x": .1, "y": .225, "width": .2, "height": .02},
        ]).json()
        self.assertEqual(underline["kind"], "underline")
        self.assertEqual([rect["underline_edge"] for rect in underline["rects"]], ["left", "bottom"])
        initialize()
        loaded = self.request("GET", f"/papers/{self.first}/annotations").json()
        self.assertEqual(len(loaded), 4)
        self.assertEqual({item["pdf_kind"] for item in loaded}, {"original", "mono", "dual"})
        for expected in marks:
            item = next(saved for saved in loaded if saved["id"] == expected["id"])
            self.assertEqual(len(item["rects"]), 2)
            self.assertEqual(item["selected_text"], "137 independent samples")
            self.assertEqual(item["comment"], f"{item['pdf_kind']} 独立批注")
            self.assertAlmostEqual(item["rects"][0]["x"], .1)
        self.assertEqual(next(item for item in loaded if item["id"] == underline["id"])["kind"], "underline")
        self.assertEqual([rect["underline_edge"] for rect in next(item for item in loaded if item["id"] == underline["id"])["rects"]], ["left", "bottom"])
        legacy_rects = [{"x": .1, "y": .2, "width": .3, "height": .02}]
        with connect() as db:
            db.execute("UPDATE paper_annotations SET rects_json = ? WHERE id = ?", (json.dumps(legacy_rects), underline["id"]))
        legacy = next(item for item in self.request("GET", f"/papers/{self.first}/annotations").json() if item["id"] == underline["id"])
        self.assertEqual(legacy["rects"], legacy_rects, "Legacy annotation JSON without underline_edge must still load unchanged")
        self.assertEqual(self.request("GET", f"/papers/{self.second}/annotations").json(), [])

    def test_selected_sentence_translation_reuses_free_service(self):
        sentence = "The measured signal increased by 23.7 percent."
        response = self.request("POST", f"/papers/{self.first}/translate-selection", {"text": sentence})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"translation": f"测试译文：{sentence}"})
        for text in ("", "   ", "x" * 10001):
            with self.subTest(text_length=len(text)):
                self.assertEqual(self.request("POST", f"/papers/{self.first}/translate-selection", {"text": text}).status_code, 422)

    def test_update_and_delete_only_target_annotation(self):
        first = self.mark().json()
        second = self.mark(self.second, kind="comment", comment="其他论文").json()
        url = f"/papers/{self.first}/annotations/{first['id']}"
        changed = self.request("PATCH", url, {"comment": "更新的批注", "color": "green"})
        self.assertEqual(changed.status_code, 200, changed.text)
        loaded = self.request("GET", f"/papers/{self.first}/annotations").json()[0]
        self.assertEqual(loaded["comment"], "更新的批注")
        self.assertEqual(loaded["color"], "green")
        self.assertEqual(self.request("DELETE", url).status_code, 200)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/annotations").json(), [])
        self.assertEqual(self.request("GET", f"/papers/{self.second}/annotations").json()[0]["id"], second["id"])

    def test_cross_paper_ids_cannot_change_or_delete_marks(self):
        mark = self.mark().json()
        url = f"/papers/{self.second}/annotations/{mark['id']}"
        for method, body in (("PATCH", {"comment": "cross paper"}), ("DELETE", None)):
            self.assertEqual(self.request(method, url, body).status_code, 404)
        self.assertEqual(len(self.request("GET", f"/papers/{self.first}/annotations").json()), 1)

    def test_all_mutations_and_reads_require_session(self):
        mark = self.mark().json()
        cases = [("GET", "notes", None), ("PUT", "notes", {"text": "forbidden"}), ("GET", "annotations", None), ("POST", "annotations", {}), ("POST", "translate-selection", {"text": "forbidden"}), ("PATCH", f"annotations/{mark['id']}", {"comment": "forbidden"}), ("DELETE", f"annotations/{mark['id']}", None)]
        for method, suffix, body in cases:
            with self.subTest(method=method, suffix=suffix):
                self.assertEqual(self.request(method, f"/papers/{self.first}/{suffix}", body, token="bad-token").status_code, 401)

    def test_unknown_papers_cannot_create_orphan_notes_or_annotations(self):
        for method, suffix, body in (("GET", "notes", None), ("PUT", "notes", {"text": "orphan"}), ("GET", "annotations", None), ("POST", "translate-selection", {"text": "orphan"})):
            self.assertEqual(self.request(method, f"/papers/missing/{suffix}", body).status_code, 404)
        self.assertEqual(self.mark("missing").status_code, 404)

    def test_annotation_rect_limit_allows_many_text_fragments_but_remains_bounded(self):
        rects = [{"x": index / 1000, "y": .2, "width": .001, "height": .01} for index in range(512)]
        response = self.mark(rects=rects)
        self.assertEqual(response.status_code, 200, response.text)
        rects.append({"x": .512, "y": .2, "width": .001, "height": .01})
        self.assertEqual(self.mark(rects=rects).status_code, 422)

    def test_invalid_pages_kinds_colors_and_coordinates_rejected(self):
        page_count = app.require_paper(self.first)["page_count"]
        invalid = [{"page_no": 0}, {"page_no": page_count + 1}, {"page_no": 1.5}, {"pdf_kind": "other"}, {"kind": "unknown"}, {"color": "red;position:fixed"}, {"rects": []}, {"rects": [{"x": -.1, "y": .2, "width": .3, "height": .02}]}, {"rects": [{"x": .8, "y": .2, "width": .3, "height": .02}]}, {"rects": [{"x": .1, "y": .99, "width": .3, "height": .02}]}, {"rects": [{"x": .1, "y": .2, "width": 0, "height": .02}]}, {"rects": [{"x": .1, "y": .2, "width": .3, "height": -1}]}, {"rects": [{"x": .1, "y": .2, "width": .3, "height": .02, "underline_edge": "diagonal"}]}]
        for body in invalid:
            with self.subTest(body=body):
                self.assertEqual(self.mark(**body).status_code, 422)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/annotations").json(), [])

    def test_nonfinite_coordinates_are_rejected(self):
        async def call(value):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url="http://test", headers={"Authorization": "Bearer notes-review-token"}) as client:
                raw = '{"pdf_kind":"original","page_no":1,"kind":"highlight","color":"yellow","selected_text":"x","comment":"","rects":[{"x":' + value + ',"y":0.1,"width":0.1,"height":0.1}]}'
                return await client.post(f"/papers/{self.first}/annotations", content=raw, headers={"Content-Type": "application/json"})
        for value in ("1e309", "-1e309"):
            with self.subTest(value=value):
                self.assertEqual(asyncio.run(call(value)).status_code, 422)

    def test_legacy_initialize_keeps_notes_chat_identity_and_source(self):
        app.add_chat_message(self.first, "user", "原有阅读记录")
        source = app.pdf_path(app.require_paper(self.first))
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        with connect() as db:
            db.execute("DROP TABLE paper_annotations")
            db.execute("DROP TABLE paper_notes")
        initialize()
        self.request("PUT", f"/papers/{self.first}/notes", {"text": "旧文献的新笔记"})
        self.mark()
        initialize()
        initialize()
        self.assertEqual(app.get_chat(self.first)[0]["content"], "原有阅读记录")
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").json()["text"], "旧文献的新笔记")
        self.assertEqual(len(self.request("GET", f"/papers/{self.first}/annotations").json()), 1)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)

    def test_paper_delete_cascades_notes_marks_but_preserves_other_paper(self):
        for paper in (self.first, self.second):
            self.request("PUT", f"/papers/{paper}/notes", {"text": f"{paper} 独立记录"})
            self.mark(paper)
        response = self.request("DELETE", f"/papers/{self.first}")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/notes").status_code, 404)
        self.assertEqual(self.request("GET", f"/papers/{self.first}/annotations").status_code, 404)
        self.assertEqual(self.request("GET", f"/papers/{self.second}/notes").json()["text"], f"{self.second} 独立记录")
        self.assertEqual(len(self.request("GET", f"/papers/{self.second}/annotations").json()), 1)
        with connect() as db:
            for table in ("paper_notes", "paper_annotations"):
                self.assertEqual(db.execute(f"SELECT COUNT(*) FROM {table} WHERE paper_id=?", (self.first,)).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
