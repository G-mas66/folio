"""Bibliography capture, correction, PDF association, and authorization contracts."""

import asyncio
import base64
import hashlib
import os
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI, Header, HTTPException

from backend import literature
from backend.db import connect, initialize


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

        with patch.object(literature, "_crossref_metadata", new=AsyncMock(return_value={})):
            failed_lookup = self.capture({"doi": "10.5555/no-record"})
        self.assertEqual(failed_lookup.status_code, 200, failed_lookup.text)
        self.assertEqual(failed_lookup.json()["item"]["doi"], "10.5555/no-record")

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

    def test_only_a_new_secondary_record_may_be_merged_after_duplicate_pdf_import(self):
        source = b"%PDF-1.7\nduplicate local PDF"
        paper_id = self.add_paper(source)
        associated = self.capture({"paper_id": paper_id, "title": "Existing PDF record"}).json()["item"]

        merged_response = self.capture({
            "doi": "10.5555/new-reference",
            "title": "New DOI reference",
            "pdf_content_base64": base64.b64encode(source).decode("ascii"),
            "pdf_name": "duplicate.pdf",
        })
        self.assertEqual(merged_response.status_code, 200, merged_response.text)
        merged = merged_response.json()
        self.assertEqual(merged["item"]["id"], associated["id"])
        self.assertEqual(merged["item"]["paper_id"], paper_id)
        self.assertEqual(merged["item"]["doi"], "10.5555/new-reference")
        self.assertEqual(merged["pdf_import"]["status"], "duplicate")
        self.assertEqual(self.request("GET", "/literature").json()["total"], 1)

    def test_existing_csl_id_is_preserved_when_its_pdf_maps_to_another_existing_record(self):
        source = b"%PDF-1.7\nconflicting local PDF"
        paper_id = self.add_paper(source)
        associated = self.capture({"paper_id": paper_id, "title": "Already linked"}).json()["item"]
        cited = self.capture({"doi": "10.5555/already-cited", "title": "Keep this CSL id"}).json()["item"]

        response = self.capture({
            "doi": "10.5555/already-cited",
            "pdf_content_base64": base64.b64encode(source).decode("ascii"),
            "pdf_name": "conflict.pdf",
        })
        self.assertEqual(response.status_code, 207, response.text)
        result = response.json()
        self.assertEqual(result["pdf_import"]["status"], "conflict")
        self.assertIn("稳定 ID", result["pdf_import"]["error"])
        self.assertEqual(result["item"]["id"], cited["id"])

        cited_after = self.request("GET", "/literature/" + cited["id"]).json()
        associated_after = self.request("GET", "/literature/" + associated["id"]).json()
        self.assertEqual(cited_after["csl"]["id"], cited["id"])
        self.assertIsNone(cited_after["paper_id"])
        self.assertEqual(associated_after["csl"]["id"], associated["id"])
        self.assertEqual(associated_after["paper_id"], paper_id)
        self.assertEqual(self.request("GET", "/literature").json()["total"], 2)
