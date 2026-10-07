"""Independent state and persistence checks using synthetic PDFs and replies."""

import asyncio
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pypdf import PdfReader, PdfWriter, Transformation

from backend import app, free_translation
from backend.db import connect, initialize
from review.paths import FIXTURE_ROOT, REVIEW_ROOT


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = FIXTURE_ROOT


def fake_translation(text, *, context="", paper_id=None):
    return "石英测量研究" if "这是论文标题" in context else "测试译文：" + text


translate_text = fake_translation


async def fixture_pdf_engine(paper_id):
    paper = app.require_paper(paper_id)
    folder = app.pdf_path(paper).parent
    original = PdfReader(app.pdf_path(paper))
    mono, dual = PdfWriter(), PdfWriter()
    for page in original.pages:
        mono.add_page(page)
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        combined = dual.add_blank_page(width=width*2, height=height)
        combined.merge_page(page)
        combined.merge_transformed_page(page, Transformation().translate(tx=width))
    mono.write(folder / 'fixture-mono.pdf')
    dual.write(folder / 'fixture-dual.pdf')
    with connect() as db:
        db.execute("UPDATE papers SET mono_pdf_file_name='fixture-mono.pdf', dual_pdf_file_name='fixture-dual.pdf', pdf_progress=100, status='completed' WHERE id=? AND status='translating'", (paper_id,))
    return 'fixture-mono.pdf', 'fixture-dual.pdf'


class FixtureFreeClient:
    max_workers = 1

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def translate(self, text, *, cancelled=None):
        if cancelled and cancelled():
            return None
        context = "这是论文标题。" if text == "A Study of Quartz Measurements" else ""
        return translate_text(text, context=context)


class TranslationFlowReview(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=REVIEW_ROOT)
        self.environment = patch.dict(os.environ, {"WORKBENCH_DATA_DIR": self.temporary.name})
        self.environment.start()
        self.provider = patch.object(free_translation, "FreeTranslationClient", FixtureFreeClient)
        self.provider.start()
        self.engine = patch.object(app, 'run_pdf_engine', fixture_pdf_engine)
        self.engine.start()
        initialize()
        app.worker_wakeup = asyncio.Event()

    def tearDown(self):
        self.engine.stop()
        self.provider.stop()
        self.environment.stop()
        self.temporary.cleanup()

    def test_import_translates_without_opening_and_preserves_source(self):
        source = FIXTURES / "quartz_alpha.pdf"
        original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        first = app.import_pdf(str(source))
        duplicate = app.import_pdf(str(source))
        second = app.import_pdf(str(FIXTURES / "quartz_beta_same_title.pdf"))
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(first["paper"]["id"], duplicate["paper"]["id"])
        with patch("review.test_translation_flow.translate_text", side_effect=fake_translation) as requests:
            app.store_status(first["paper"]["id"], "translating")
            asyncio.run(app.translate_paper(first["paper"]["id"]))
            app.store_status(second["paper"]["id"], "translating")
            asyncio.run(app.translate_paper(second["paper"]["id"]))
        alpha = app.paper_view(app.require_paper(first["paper"]["id"]))
        beta = app.paper_view(app.require_paper(second["paper"]["id"]))
        self.assertTrue(alpha["can_read"])
        self.assertEqual(alpha['pdf_progress'], 100)
        self.assertTrue((app.pdf_path(app.require_paper(alpha['id'])).parent / alpha['mono_pdf_file_name']).is_file())
        self.assertTrue((app.pdf_path(app.require_paper(alpha['id'])).parent / alpha['dual_pdf_file_name']).is_file())
        self.assertTrue(alpha["file_name"].startswith("石英测量研究"))
        self.assertNotEqual(alpha["file_name"], beta["file_name"])
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_hash)
        self.assertEqual(requests.call_count, 2, 'only the two titles use the plain text translator')

    def test_pdf_failure_blocks_reading_and_retry_reuses_saved_title(self):
        paper_id = app.import_pdf(str(FIXTURES / "quartz_alpha.pdf"))["paper"]["id"]
        async def fail_with_partial_pdf(target):
            paper = app.require_paper(target)
            (app.pdf_path(paper).parent / 'incomplete-mono.pdf').write_bytes(app.pdf_path(paper).read_bytes())
            with connect() as db:
                db.execute("UPDATE papers SET mono_pdf_file_name='incomplete-mono.pdf' WHERE id=?", (target,))
            raise RuntimeError('test PDF engine failure')
        app.store_status(paper_id, "translating")
        with patch.object(app, 'run_pdf_engine', fail_with_partial_pdf):
            asyncio.run(app.translate_paper(paper_id))
        partial = app.paper_view(app.require_paper(paper_id))
        self.assertEqual(partial["status"], "error")
        self.assertFalse(partial["can_read"])
        self.assertEqual(partial['chinese_title'], '石英测量研究')
        app.schedule(paper_id)
        app.store_status(paper_id, "translating")
        with patch("review.test_translation_flow.translate_text", side_effect=fake_translation) as resumed:
            asyncio.run(app.translate_paper(paper_id))
        self.assertEqual(resumed.call_count, 0, 'retry must reuse the saved Chinese title')
        self.assertTrue(app.paper_view(app.require_paper(paper_id))["can_read"])

    def test_stopped_task_is_not_completed_or_auto_resumed(self):
        paper_id = app.import_pdf(str(FIXTURES / "quartz_alpha.pdf"))["paper"]["id"]

        async def stop_during_translation(target):
            app.store_status(target, 'stopped')

        app.store_status(paper_id, "translating")
        with patch.object(app, 'run_pdf_engine', stop_during_translation):
            asyncio.run(app.translate_paper(paper_id))
        stopped = app.paper_view(app.require_paper(paper_id))
        self.assertEqual(stopped["status"], "stopped")
        self.assertFalse(stopped["can_read"])

        async def restart():
            await app.startup()
            self.assertEqual(app.require_paper(paper_id)["status"], "stopped")
            await app.shutdown()

        asyncio.run(restart())


if __name__ == "__main__":
    unittest.main()
