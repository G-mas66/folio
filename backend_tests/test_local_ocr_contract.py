"""OCR preferences, blocked-paper recovery and atomic OCR publication."""
import asyncio
import hashlib
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from reportlab.pdfgen import canvas

from backend import app
from backend.db import connect, initialize


class LocalOcrContract(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.environment = patch.dict(os.environ, {"WORKBENCH_DATA_DIR": str(self.root), "WORKBENCH_SESSION_TOKEN": "ocr-test"})
        self.environment.start()
        initialize()
        source = self.root / "source.pdf"
        pdf = canvas.Canvas(str(source))
        pdf.drawString(50, 750, "A Synthetic Study of Offline Document Recognition")
        pdf.drawString(50, 700, "Native text must keep its existing segment identity.")
        pdf.showPage()
        pdf.rect(50, 50, 100, 100, fill=1)
        pdf.save()
        self.paper = app.import_pdf(str(source))["paper"]
        self.paper_id = self.paper["id"]
        self.original = app.pdf_path(app.require_paper(self.paper_id))
        self.source_hash = hashlib.sha256(self.original.read_bytes()).hexdigest()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def request(self, method, path, body=None, token="ocr-test"):
        async def call():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url="http://test", headers={"Authorization": f"Bearer {token}"}) as client:
                return await client.request(method, path, json=body)
        return asyncio.run(call())

    def test_preferences_survive_reopen_and_preserve_ai_configuration(self):
        with connect() as db:
            db.execute("INSERT INTO settings(id, base_url, model, updated_at) VALUES (1, 'https://example.test/v1', 'existing-model', '')")
        status = {"available": True, "languages": [{"tag": "en-US", "name": "English"}]}
        with patch.object(app, "local_ocr_status", return_value=status):
            self.assertEqual(self.request("PUT", "/settings/ocr", {"enabled": False, "language": "en-US"}).status_code, 200)
            initialize()
            settings = self.request("GET", "/settings/ocr").json()
            self.assertFalse(settings["enabled"])
            self.assertEqual(settings["language"], "en-US")
            self.assertEqual(self.request("PUT", "/settings/ocr", {"enabled": True, "language": "invalid"}).status_code, 422)
            self.assertEqual(self.request("PUT", "/settings/ocr", {"enabled": True}, token="wrong").status_code, 401)
        with connect() as db:
            self.assertEqual(tuple(db.execute("SELECT base_url, model FROM settings").fetchone()), ("https://example.test/v1", "existing-model"))

    def test_original_is_readable_and_blocked_paper_can_retry_ocr(self):
        app.store_status(self.paper_id, "needs_attention", "missing text on page 2")
        result = self.request("GET", f"/papers/{self.paper_id}").json()
        self.assertFalse(result["can_read"])
        self.assertTrue(result["can_read_original"])
        self.assertEqual(self.request("GET", f"/papers/{self.paper_id}/pdf").status_code, 200)
        with patch.object(app.sys, "platform", "win32"):
            result = self.request("POST", f"/papers/{self.paper_id}/translation/retry")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["status"], "queued")

    def test_disabled_or_unavailable_ocr_never_claims_completion(self):
        with patch.object(app, "local_ocr_status", return_value={"available": False, "languages": [], "error": "not installed"}):
            self.assertEqual(self.request("PUT", "/settings/ocr", {"enabled": True}).status_code, 422)
            self.assertEqual(self.request("PUT", "/settings/ocr", {"enabled": False}).status_code, 200)
        app.schedule(self.paper_id)
        self.assertEqual(app.require_paper(self.paper_id)["status"], "needs_attention")

    def make_helper(self, *, recognized=True, slow=False):
        helper = self.root / "helper.py"
        helper.write_text(
            "import io,json,pathlib,sys,time\nfrom pypdf import PdfReader,PdfWriter\nfrom reportlab.pdfgen import canvas\n"
            "_,source,output,home=sys.argv[1:]\nsource=pathlib.Path(source); output=pathlib.Path(output)\n"
            + ("time.sleep(15)\n" if slow else "")
            + "reader=PdfReader(source); writer=PdfWriter()\n"
            + ("buffer=io.BytesIO(); pdf=canvas.Canvas(buffer); pdf.drawString(50,700,'Recovered OCR appendix text'); pdf.save(); reader.pages[1].merge_page(PdfReader(buffer).pages[0])\n" if recognized else "")
            + "for page in reader.pages: writer.add_page(page)\n"
            "result=output/'ocr.pdf'; writer.write(result)\n"
            "print(json.dumps({'type':'finish','ocr_pdf_path':str(result),'ocr_pages':[2]}),flush=True)\n",
            encoding="utf-8")
        return patch.dict(os.environ, {"WORKBENCH_PDF_ENGINE_BIN": sys.executable, "WORKBENCH_PDF_ENGINE_ENTRY": str(helper)})

    def test_ocr_copy_and_new_segments_publish_without_changing_existing_anchors(self):
        with connect() as db:
            before = [tuple(row) for row in db.execute("SELECT id, original_text FROM segments WHERE paper_id = ?", (self.paper_id,))]
        app.store_status(self.paper_id, "translating")
        with self.make_helper():
            result = asyncio.run(app.run_pdf_engine(self.paper_id, ocr_only=True))
        self.assertTrue(result)
        paper = app.require_paper(self.paper_id)
        self.assertTrue((self.original.parent / paper["ocr_pdf_file_name"]).is_file())
        self.assertEqual(app.paper_view(paper)["ocr_pages"], [2])
        self.assertEqual(app.paper_view(paper)["diagnostics"], [])
        self.assertEqual(hashlib.sha256(self.original.read_bytes()).hexdigest(), self.source_hash)
        with connect() as db:
            self.assertEqual(before, [tuple(row) for row in db.execute("SELECT id, original_text FROM segments WHERE paper_id = ? AND start_page = 1", (self.paper_id,))])
            self.assertIn("Recovered OCR", db.execute("SELECT original_text FROM segments WHERE paper_id = ? AND start_page = 2", (self.paper_id,)).fetchone()[0])
        self.assertEqual(list(self.original.parent.glob(".engine-*")), [])

    def test_incomplete_ocr_result_is_rejected_without_publishing(self):
        app.store_status(self.paper_id, "translating")
        with self.make_helper(recognized=False):
            with self.assertRaisesRegex(ValueError, "仍有页面缺少文字"):
                asyncio.run(app.run_pdf_engine(self.paper_id, ocr_only=True))
        self.assertEqual(app.require_paper(self.paper_id)["ocr_pdf_file_name"], "")
        self.assertEqual(list(self.original.parent.glob("ocr-*.pdf")), [])
        self.assertEqual(list(self.original.parent.glob(".engine-*")), [])

    def test_stop_cancels_ocr_and_cleans_its_temporary_directory(self):
        async def run():
            app.store_status(self.paper_id, "translating")
            task = asyncio.create_task(app.run_pdf_engine(self.paper_id, ocr_only=True))
            while self.paper_id not in app.pdf_processes:
                await asyncio.sleep(.01)
            await app.translation_action(self.paper_id, "stop")
            self.assertIsNone(await task)
        with self.make_helper(slow=True):
            asyncio.run(run())
        self.assertEqual(app.require_paper(self.paper_id)["status"], "stopped")
        self.assertEqual(list(self.original.parent.glob(".engine-*")), [])
        self.assertNotIn(self.paper_id, app.pdf_processes)

    def test_stop_at_helper_eof_does_not_report_a_generation_failure(self):
        async def stopped_eof():
            app.store_status(self.paper_id, "stopped")
            return b""

        for ocr_only in (False, True):
            with self.subTest(ocr_only=ocr_only), self.make_helper():
                app.store_status(self.paper_id, "translating")
                process = SimpleNamespace(
                    returncode=-15, wait=AsyncMock(return_value=-15),
                    stdout=SimpleNamespace(readline=AsyncMock(side_effect=stopped_eof)),
                )
                with patch.object(asyncio, "create_subprocess_exec", AsyncMock(return_value=process)):
                    self.assertIsNone(asyncio.run(app.run_pdf_engine(self.paper_id, ocr_only=ocr_only)))
                self.assertEqual(app.require_paper(self.paper_id)["status"], "stopped")
                self.assertEqual(list(self.original.parent.glob(".engine-*")), [])
                self.assertNotIn(self.paper_id, app.pdf_processes)


if __name__ == "__main__":
    unittest.main()
