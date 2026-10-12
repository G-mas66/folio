"""Bibliography capture, correction, PDF association, and authorization contracts."""

import asyncio
import base64
import hashlib
import os
import shutil
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, Header, HTTPException

from backend import literature
from backend.db import connect, initialize


class CrossrefPublicationMetadata(unittest.TestCase):
    def test_conference_chapter_requires_explicit_conference_evidence(self):
        message = {
            "type": "book-chapter", "title": ["UNet++"],
            "container-title": ["Lecture Notes in Computer Science", "Deep Learning in Medical Image Analysis"],
            "author": [{"given": "Md Mahfuzur", "family": "Rahman Siddiquee"}],
            "publisher": "Springer International Publishing", "publisher-location": "Cham", "page": "3-11",
            "assertion": [{"name": "conference_name", "value": "International Workshop on Deep Learning in Medical Image Analysis"}],
        }
        client_class = httpx.AsyncClient
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"message": message}, request=request))
        with patch.object(httpx, "AsyncClient", side_effect=lambda **kwargs: client_class(transport=transport, **kwargs)):
            conference = asyncio.run(literature._crossref_metadata("10.1007/978-3-030-00889-5_1"))
            message["assertion"] = []
            chapter = asyncio.run(literature._crossref_metadata("10.1007/ordinary-chapter"))
        self.assertEqual(conference["item_type"], "paper-conference")
        self.assertEqual(chapter["item_type"], "chapter")
        self.assertEqual(conference["container_title"], "Deep Learning in Medical Image Analysis")
        self.assertEqual(conference["authors"][0]["family"], "Rahman Siddiquee")
        self.assertEqual(conference["publisher_place"], "Cham")
        self.assertEqual(conference["publisher"], "Springer International Publishing")


class LiteraturePluginContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"WORKBENCH_DATA_DIR": self.temporary.name})
        self.environment.start()
        initialize()
        self.imported_paths = []
        self.importer = self.import_pdf
        self.crossref = patch.object(literature, "_crossref_metadata", new=AsyncMock(return_value={}))
        self.crossref.start()
        self.web = FastAPI()
        literature.register(self.web, self.authorize, self.call_importer)

    def tearDown(self):
        self.crossref.stop()
        self.environment.stop()
        self.temporary.cleanup()

    @staticmethod
    def authorize(authorization: str = Header(default="")):
        if authorization != "Bearer literature-plugin-token":
            raise HTTPException(status_code=401, detail="unauthorized")

    def call_importer(self, path, folder_id):
        return self.importer(path, folder_id)

    def import_pdf(self, path, folder_id):
        self.imported_paths.append(path)
        with open(path, "rb") as source:
            content = source.read()
        digest = hashlib.sha256(content).hexdigest()
        with connect() as db:
            existing = db.execute("SELECT id FROM papers WHERE source_hash = ?", (digest,)).fetchone()
            if existing:
                return {"paper": {"id": existing["id"]}, "duplicate": True}
            paper_id = uuid.uuid4().hex
            timestamp = datetime.now(timezone.utc).isoformat()
            db.execute(
                "INSERT INTO papers(id, source_hash, source_name, file_name, english_title, chinese_title, source_language, title_confident, page_count, status, error, created_at, updated_at, folder_id) "
                "VALUES (?, ?, ?, ?, ?, '', 'unknown', 0, 1, 'queued', '', ?, ?, ?)",
                (paper_id, digest, os.path.basename(path), "captured.pdf", os.path.basename(path), timestamp, timestamp, folder_id),
            )
        return {"paper": {"id": paper_id}, "duplicate": False}

    def add_paper(self, content):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as source:
            source.write(content)
            path = source.name
        try:
            return self.import_pdf(path, None)["paper"]["id"]
        finally:
            os.unlink(path)

    @staticmethod
    def add_folder(name):
        folder_id = uuid.uuid4().hex
        timestamp = datetime.now(timezone.utc).isoformat()
        with connect() as db:
            db.execute("INSERT INTO folders(id, name, created_at, color) VALUES (?, ?, ?, '')", (folder_id, name, timestamp))
        return folder_id

    def request(self, method, url, body=None, *, token="literature-plugin-token"):
        async def call():
            headers = {"Authorization": "Bearer " + token} if token else {}
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.web),
                base_url="http://test",
                headers=headers,
            ) as client:
                return await client.request(method, url, json=body)
        return asyncio.run(call())

    def capture(self, body, **kwargs):
        return self.request("POST", "/literature/capture", body, **kwargs)

    def test_authorization_missing_metadata_and_manual_correction(self):
        self.assertEqual(self.request("GET", "/literature", token="").status_code, 401)
        created = self.capture({})
        self.assertEqual(created.status_code, 200, created.text)
        item = created.json()["item"]
        self.assertEqual(item["missing_fields"], ["title", "authors", "year", "container_title", "doi", "url"])
        self.assertEqual(item["csl"]["id"], item["id"])

        corrected = self.request("PATCH", "/literature/" + item["id"], {
            "title": "Corrected title",
            "authors": [{"given": "Ada", "family": "Lovelace"}],
            "year": 2024,
        })
        self.assertEqual(corrected.status_code, 200, corrected.text)
        saved = self.request("GET", "/literature/" + item["id"]).json()
        self.assertEqual(saved["title"], "Corrected title")
        self.assertEqual(saved["authors"], [{"given": "Ada", "family": "Lovelace"}])
        self.assertEqual(saved["year"], 2024)
        self.assertEqual(saved["field_sources"]["title"], "user")
        self.assertEqual(saved["csl"]["id"], item["id"])

    def test_crossref_fills_missing_fields_but_doi_lookup_failure_does_not_block_save(self):
        metadata = {
            "title": "Crossref title",
            "authors": [{"given": "Grace", "family": "Hopper"}],
            "year": 2022,
            "container_title": "Journal of Tests",
            "url": "https://doi.org/10.5555/folio.22",
            "volume": "4",
            "issue": "2",
            "pages": "10-19",
            "publisher": "Test Publisher",
            "publisher_place": "London",
            "item_type": "journal-article",
        }
        with patch.object(literature, "_crossref_metadata", new=AsyncMock(return_value=metadata)):
            created = self.capture({"doi": "10.5555/folio.22"})
        self.assertEqual(created.status_code, 200, created.text)
        item = created.json()["item"]
        self.assertEqual(item["title"], "Crossref title")
        self.assertEqual(item["year"], 2022)
        self.assertEqual(item["field_sources"]["title"], "crossref")
        self.assertEqual(item["csl"]["type"], "article-journal")
        self.assertEqual(item["csl"]["page"], "10-19")
        self.assertEqual(item["csl"]["publisher"], "Test Publisher")
        self.assertEqual(item["csl"]["publisher-place"], "London")
        self.assertEqual(item["field_sources"]["publisher"], "crossref")

        with patch.object(literature, "_crossref_metadata", new=AsyncMock(return_value={})):
            failed_lookup = self.capture({"doi": "10.5555/no-record"})
        self.assertEqual(failed_lookup.status_code, 200, failed_lookup.text)
        self.assertEqual(failed_lookup.json()["item"]["doi"], "10.5555/no-record")

    def test_conference_correction_preserves_id_and_pdf_association(self):
        paper_id = self.add_paper(b"%PDF-1.7\nunet fixture")
        item = self.capture({"paper_id": paper_id, "doi": "10.48550/arXiv.1807.10165"}).json()["item"]
        correction = {
            "title": "UNet++: A Nested U-Net Architecture for Medical Image Segmentation",
            "authors": [{"family": "Zhou", "given": "Zongwei"}, {"family": "Rahman Siddiquee", "given": "Md Mahfuzur"}],
            "year": 2018, "item_type": "paper-conference",
            "container_title": "Deep Learning in Medical Image Analysis and Multimodal Learning for Clinical Decision Support",
            "publisher": "Springer International Publishing", "publisher_place": "Cham", "pages": "3-11",
            "doi": "10.1007/978-3-030-00889-5_1",
        }
        response = self.request("PATCH", "/literature/" + item["id"], correction)
        self.assertEqual(response.status_code, 200, response.text)
        saved = self.request("GET", "/literature/" + item["id"]).json()
        self.assertEqual(saved["id"], item["id"])
        self.assertEqual(saved["paper_id"], paper_id)
        for field, value in correction.items():
            self.assertEqual(saved[field], value)
            self.assertEqual(saved["field_sources"][field], "user")
        self.assertEqual(saved["csl"]["type"], "paper-conference")
        self.assertEqual(saved["csl"]["publisher-place"], "Cham")
        self.assertEqual(saved["csl"]["publisher"], "Springer International Publishing")

    def test_publisher_migration_preserves_existing_records(self):
        item = self.capture({"title": "Existing library"}).json()["item"]
        with connect() as db:
            db.execute("ALTER TABLE literature_records DROP COLUMN publisher")
            db.execute("ALTER TABLE literature_records DROP COLUMN publisher_place")
        literature.ensure_tables()
        literature.ensure_tables()
        saved = self.request("GET", "/literature/" + item["id"]).json()
        self.assertEqual(saved["title"], "Existing library")
        self.assertEqual(saved["publisher"], "")
        self.assertEqual(saved["publisher_place"], "")

    def test_ordinary_pdf_import_associates_a_saved_record(self):
        source = b"%PDF-1.7\nordinary local PDF"
        response = self.capture({
            "title": "A locally imported paper",
            "pdf_content_base64": base64.b64encode(source).decode("ascii"),
            "pdf_name": "ordinary.pdf",
        })
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["pdf_import"]["status"], "imported")
        self.assertTrue(result["item"]["paper_id"])
        self.assertEqual(result["item"]["title"], "A locally imported paper")
        self.assertFalse(os.path.exists(self.imported_paths[-1]))

    def test_pdf_import_failure_keeps_bibliography_record(self):
        self.importer = lambda _path, _folder: (_ for _ in ()).throw(ValueError("fixture import failure"))
        response = self.capture({
            "title": "Keep this reference",
            "pdf_content_base64": base64.b64encode(b"%PDF-1.7\nfixture").decode("ascii"),
            "pdf_name": "broken.pdf",
        })
        self.assertEqual(response.status_code, 207, response.text)
        result = response.json()
        self.assertEqual(result["pdf_import"]["status"], "failed")
        self.assertEqual(result["pdf_import"]["error"], "fixture import failure")
        saved = self.request("GET", "/literature/" + result["item"]["id"])
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["title"], "Keep this reference")
        self.assertIsNone(saved.json()["paper_id"])

    def test_duplicate_pdf_keeps_an_unversioned_record_separate_from_doi_record(self):
        source = b"%PDF-1.7\nduplicate local PDF"
        paper_id = self.add_paper(source)
        associated = self.capture({"paper_id": paper_id, "title": "Existing PDF record"}).json()["item"]

        separate_response = self.capture({
            "doi": "10.5555/new-reference",
            "title": "New DOI reference",
            "pdf_content_base64": base64.b64encode(source).decode("ascii"),
            "pdf_name": "duplicate.pdf",
        })
        self.assertEqual(separate_response.status_code, 200, separate_response.text)
        separate = separate_response.json()
        self.assertNotEqual(separate["item"]["id"], associated["id"])
        self.assertEqual(separate["item"]["paper_id"], paper_id)
        self.assertEqual(separate["item"]["doi"], "10.5555/new-reference")
        self.assertEqual(separate["pdf_import"]["status"], "duplicate")
        self.assertEqual(self.request("GET", "/literature").json()["total"], 2)
        self.assertEqual(self.request("GET", "/literature/" + associated["id"]).json()["paper_id"], paper_id)

    def test_different_doi_record_can_share_a_pdf_without_merging(self):
        source = b"%PDF-1.7\nshared PDF, separate DOI editions"
        first = self.capture({
            "doi": "10.5555/preprint", "title": "Preprint",
            "pdf_content_base64": base64.b64encode(source).decode("ascii"), "pdf_name": "shared.pdf",
        }).json()
        second = self.capture({
            "doi": "10.5555/published", "title": "Published article",
            "pdf_content_base64": base64.b64encode(source).decode("ascii"), "pdf_name": "shared.pdf",
        }).json()
        self.assertEqual(second["pdf_import"]["status"], "duplicate")
        self.assertNotEqual(first["item"]["id"], second["item"]["id"])
        self.assertEqual(first["item"]["paper_id"], second["item"]["paper_id"])
        self.assertEqual(first["item"]["csl"]["id"], first["item"]["id"])
        self.assertEqual(second["item"]["csl"]["id"], second["item"]["id"])
        self.assertEqual({item["doi"] for item in self.request("GET", "/literature").json()["items"]}, {"10.5555/preprint", "10.5555/published"})

    def test_same_doi_record_can_keep_its_id_when_linked_to_existing_pdf(self):
        source = b"%PDF-1.7\nconflicting local PDF"
        paper_id = self.add_paper(source)
        associated = self.capture({"paper_id": paper_id, "title": "Already linked"}).json()["item"]
        cited = self.capture({"doi": "10.5555/already-cited", "title": "Keep this CSL id"}).json()["item"]

        response = self.capture({
            "doi": "10.5555/already-cited",
            "pdf_content_base64": base64.b64encode(source).decode("ascii"),
            "pdf_name": "conflict.pdf",
        })
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["pdf_import"]["status"], "duplicate")
        self.assertEqual(result["item"]["id"], cited["id"])

        cited_after = self.request("GET", "/literature/" + cited["id"]).json()
        associated_after = self.request("GET", "/literature/" + associated["id"]).json()
        self.assertEqual(cited_after["csl"]["id"], cited["id"])
        self.assertEqual(cited_after["paper_id"], paper_id)
        self.assertEqual(associated_after["csl"]["id"], associated["id"])
        self.assertEqual(associated_after["paper_id"], paper_id)
        self.assertEqual(self.request("GET", "/literature").json()["total"], 2)

    def test_folders_filter_metadata_and_follow_linked_papers(self):
        folder_a = self.add_folder("Folder A")
        folder_b = self.add_folder("Folder B")
        paper_id = self.add_paper(b"%PDF-1.7\nfolder-linked paper")
        with connect() as db:
            db.execute("UPDATE papers SET folder_id = ? WHERE id = ?", (folder_a, paper_id))
        linked = self.capture({"paper_id": paper_id, "title": "Linked record"}).json()["item"]
        unfiled = self.capture({"title": "Metadata only, unfiled"}).json()["item"]
        filed = self.capture({"title": "Metadata only, filed", "folder_id": folder_a}).json()["item"]
        self.assertEqual(linked["folder_id"], folder_a)
        self.assertEqual(unfiled["folder_id"], None)
        self.assertEqual(filed["folder_id"], folder_a)
        self.assertEqual(self.request("GET", f"/literature?folder_id={folder_a}").json()["total"], 2)
        self.assertEqual(self.request("GET", "/literature?folder_id=unfiled").json()["total"], 1)

        moved = self.request("PATCH", "/literature/" + linked["id"], {"folder_id": folder_b})
        self.assertEqual(moved.status_code, 200, moved.text)
        with connect() as db:
            self.assertEqual(db.execute("SELECT folder_id FROM papers WHERE id = ?", (paper_id,)).fetchone()["folder_id"], folder_b)
        self.assertEqual(self.request("GET", "/literature/" + linked["id"]).json()["folder_id"], folder_b)
        self.assertEqual(self.request("GET", "/literature?folder_id=" + folder_a).json()["total"], 1)
        self.assertEqual(self.request("GET", "/literature?folder_id=" + folder_b).json()["total"], 1)

        moved_metadata = self.request("PATCH", "/literature/" + filed["id"], {"folder_id": None})
        self.assertEqual(moved_metadata.status_code, 200, moved_metadata.text)
        self.assertEqual(self.request("GET", "/literature?folder_id=unfiled").json()["total"], 2)

        with connect() as db:
            db.execute("UPDATE literature_records SET folder_id = NULL WHERE id = ?", (linked["id"],))
        literature.ensure_tables()
        self.assertEqual(self.request("GET", "/literature/" + linked["id"]).json()["folder_id"], folder_b)

        with connect() as db:
            db.execute("UPDATE papers SET folder_id = ? WHERE id = ?", (folder_a, paper_id))
            self.assertEqual(db.execute("SELECT folder_id FROM literature_records WHERE id = ?", (linked["id"],)).fetchone()["folder_id"], folder_a)
            db.execute("DELETE FROM papers WHERE id = ?", (paper_id,))
        deleted_pdf_record = self.request("GET", "/literature/" + linked["id"]).json()
        self.assertIsNone(deleted_pdf_record["paper_id"])
        self.assertEqual(deleted_pdf_record["folder_id"], folder_a)

    def test_legacy_migration_preserves_ids_links_and_manual_fields(self):
        paper_id = self.add_paper(b"%PDF-1.7\nlegacy paper")
        record_id = "stable-existing-literature-id"
        timestamp = datetime.now(timezone.utc).isoformat()
        with connect() as db:
            db.executescript(
                "CREATE TABLE literature_records ("
                "id TEXT PRIMARY KEY, paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL, title TEXT NOT NULL DEFAULT '', "
                "authors_json TEXT NOT NULL DEFAULT '[]', year INTEGER, container_title TEXT NOT NULL DEFAULT '', doi TEXT NOT NULL DEFAULT '', "
                "doi_key TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', pdf_url TEXT NOT NULL DEFAULT '', pdf_key TEXT NOT NULL DEFAULT '', "
                "volume TEXT NOT NULL DEFAULT '', issue TEXT NOT NULL DEFAULT '', pages TEXT NOT NULL DEFAULT '', item_type TEXT NOT NULL DEFAULT 'article', "
                "field_sources_json TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"
                "CREATE UNIQUE INDEX literature_records_by_doi ON literature_records(doi_key) WHERE doi_key <> '';"
                "CREATE UNIQUE INDEX literature_records_by_pdf ON literature_records(pdf_key) WHERE pdf_key <> '';"
                "CREATE UNIQUE INDEX literature_records_by_paper ON literature_records(paper_id) WHERE paper_id IS NOT NULL;"
            )
            db.execute(
                "INSERT INTO literature_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (record_id, paper_id, "Manually corrected legacy title", '[{"family":"Lovelace","given":"Ada"}]', 2024,
                 "Journal of Tests", "10.5555/legacy", "10.5555/legacy", "https://doi.org/10.5555/legacy", "", "", "2", "1", "10-19",
                 "journal-article", '{"title":"user","year":"user"}', "browser", timestamp, timestamp),
            )
        literature.ensure_tables()
        saved = self.request("GET", "/literature/" + record_id)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["id"], record_id)
        self.assertEqual(saved.json()["paper_id"], paper_id)
        self.assertEqual(saved.json()["title"], "Manually corrected legacy title")
        self.assertEqual(saved.json()["year"], 2024)
        self.assertEqual(saved.json()["field_sources"]["title"], "user")
        second = self.capture({"paper_id": paper_id, "doi": "10.5555/legacy-version", "title": "Second edition"})
        self.assertEqual(second.status_code, 200, second.text)

    def test_import_parsers_preserve_source_and_compound_authors(self):
        bibtex = "@article{unet, title={UNet++}, author={John von Neumann and {World Health Organization}}, journal={Medical AI}, year=2020}"
        parsed = self.request("POST", "/literature/parse", {"format": "bibtex", "data": bibtex})
        self.assertEqual(parsed.status_code, 200, parsed.text)
        entry = parsed.json()["items"][0]
        self.assertEqual(entry["record"]["author"][0]["family"], "Neumann")
        self.assertEqual(entry["record"]["author"][0]["non-dropping-particle"], "von")
        self.assertEqual(entry["record"]["author"][1]["literal"], "World Health Organization")
        self.assertEqual(entry["source_citation"], bibtex)
        imported = self.capture({"csl": entry["record"], "source_citation": entry["source_citation"]})
        self.assertEqual(imported.status_code, 200, imported.text)
        saved = imported.json()["item"]
        self.assertEqual(saved["source_citation"], bibtex)
        self.assertEqual(saved["csl"]["author"][0]["non-dropping-particle"], "von")

        ris = "TY  - JOUR\nTI  - A RIS article\nAU  - Smith, John\nPY  - 2023/05\nER  -"
        ris_result = self.request("POST", "/literature/parse", {"format": "ris", "data": ris})
        self.assertEqual(ris_result.status_code, 200, ris_result.text)
        self.assertEqual(ris_result.json()["items"][0]["record"]["issued"]["date-parts"], [[2023, 5]])
        csl_result = self.request("POST", "/literature/parse", {"format": "csl-json", "data": '{"id":"x","type":"book","title":"A book"}'})
        self.assertEqual(csl_result.status_code, 200, csl_result.text)
        self.assertEqual(csl_result.json()["items"][0]["record"]["type"], "book")

    def test_supplement_preview_only_fills_selected_empty_nonmanual_fields(self):
        item = self.capture({"doi": "10.5555/supplement", "title": "Imported title"}).json()["item"]
        corrected = self.request("PATCH", "/literature/" + item["id"], {"title": "Manually verified title"})
        self.assertEqual(corrected.status_code, 200, corrected.text)
        metadata = {
            "title": "Registry title", "authors": [{"family": "Hopper", "given": "Grace"}], "year": 2022,
            "container_title": "Journal of Metadata", "url": "https://example.org/metadata", "volume": "3", "issue": "2",
            "pages": "20-29", "publisher": "Metadata Press", "publisher_place": "London", "item_type": "journal-article",
        }
        with patch.object(literature, "_crossref_metadata", new=AsyncMock(return_value=metadata)):
            proposal_response = self.request("POST", f"/literature/{item['id']}/supplement/preview", {})
        self.assertEqual(proposal_response.status_code, 200, proposal_response.text)
        proposal = proposal_response.json()
        self.assertTrue(proposal["changes"]["title"]["manual"])
        self.assertFalse(proposal["changes"]["title"]["fillable"])
        self.assertTrue(proposal["changes"]["authors"]["fillable"])
        with patch.object(literature, "_crossref_metadata", new=AsyncMock(return_value=metadata)):
            applied_response = self.request("POST", f"/literature/{item['id']}/supplement/apply", {
                "source_fingerprint": proposal["source_fingerprint"], "fields": ["title", "authors", "item_type"],
            })
        self.assertEqual(applied_response.status_code, 200, applied_response.text)
        applied = applied_response.json()
        self.assertEqual(applied["item"]["title"], "Manually verified title")
        self.assertEqual(applied["item"]["authors"], metadata["authors"])
        self.assertEqual(applied["item"]["item_type"], "journal-article")
        self.assertEqual(applied["skipped"], ["title"])

        changed = {**metadata, "title": "Registry title changed"}
        with patch.object(literature, "_crossref_metadata", new=AsyncMock(side_effect=[metadata, changed])):
            preview = self.request("POST", f"/literature/{item['id']}/supplement/preview", {}).json()
            stale = self.request("POST", f"/literature/{item['id']}/supplement/apply", {
                "source_fingerprint": preview["source_fingerprint"], "fields": ["volume"],
            })
        self.assertEqual(stale.status_code, 409)

    @unittest.skipUnless(shutil.which("node") or os.environ.get("WORKBENCH_CITATION_EXECUTABLE"), "shared citeproc runtime is unavailable")
    def test_shared_citeproc_preview_confirmation_staleness_and_offline_render(self):
        csl = {
            "id": "preview", "type": "article-journal", "title": "A structured title",
            "author": [{"family": "Lovelace", "given": "Ada"}], "container-title": "Journal of Tests",
            "issued": {"date-parts": [[2024]]}, "DOI": "10.5555/citation-test", "URL": "https://example.org/article",
        }
        apa = self.request("POST", "/literature/preview", {"record": csl, "style": "apa"})
        gbt = self.request("POST", "/literature/preview", {"record": csl, "style": "gb-t-7714-2015-numeric"})
        self.assertEqual(apa.status_code, 200, apa.text)
        self.assertEqual(gbt.status_code, 200, gbt.text)
        self.assertIn("Lovelace", apa.json()["bibliography_text"])
        self.assertIn("LOVELACE", gbt.json()["bibliography_text"])
        self.assertNotEqual(apa.json()["fingerprint"], gbt.json()["fingerprint"])

        created = self.capture({"csl": csl}).json()["item"]
        stored_preview = self.request("POST", "/literature/preview", {"record": created["csl"], "style": "apa"}).json()
        confirmed = self.request("POST", f"/literature/{created['id']}/citations", {"style": "apa", "fingerprint": stored_preview["fingerprint"]})
        self.assertEqual(confirmed.status_code, 200, confirmed.text)
        self.assertTrue(confirmed.json()["citations"]["apa"]["confirmed"])
        patched = self.request("PATCH", "/literature/" + created["id"], {"title": "Corrected structured title"})
        self.assertEqual(patched.status_code, 200, patched.text)
        stale = self.request("GET", "/literature/" + created["id"]).json()["citations"]["apa"]
        self.assertTrue(stale["confirmed"])
        self.assertTrue(stale["stale"])
        rejected = self.request("POST", f"/literature/{created['id']}/citations", {"style": "apa", "fingerprint": stored_preview["fingerprint"]})
        self.assertEqual(rejected.status_code, 409)

        offline_id = "offline-literature-id"
        control_id = "word-control-1"
        state = {
            "version": 1, "style": "apa",
            "items": {offline_id: {**csl, "id": offline_id}},
            "citations": [{"id": control_id, "items": [{"id": offline_id}]}],
        }
        rendered = self.request("POST", "/literature/render-document", {"state": state, "style": "apa"})
        self.assertEqual(rendered.status_code, 200, rendered.text)
        result = rendered.json()
        self.assertEqual(result["citation_order"], [control_id])
        self.assertIn(control_id, result["citations"])
        self.assertEqual(len(result["bibliography"]["entries"]), 1)
        self.assertEqual(result["incomplete_items"], [])
