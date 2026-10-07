"""Chinese source detection and no-translation import path."""

import asyncio
import hashlib
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import app
from backend.db import connect, initialize
from backend.pdf_extract import detect_source_language, extract_pdf
from review import test_translation_flow as flow


CHINESE_TEXT = "实验样本数量为137。研究采用独立测量方法，结果支持预先提出的研究假设。" * 14


def chinese_extraction():
    return {
        "page_count": 2,
        "pages": [
            {"page_no": 1, "status": "text", "text_chars": len(CHINESE_TEXT)},
            {"page_no": 2, "status": "text", "text_chars": len(CHINESE_TEXT)},
        ],
        "segments": [{"start_page": 1, "end_page": 2, "original_text": CHINESE_TEXT}],
        "english_title": "",
        "chinese_title": "中文样本研究",
        "source_language": "zh",
        "title_confident": False,
        "has_blocker": False,
    }


class ChineseImportContract(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)

    def tearDown(self):
        flow.TranslationFlowReview.tearDown(self)

    def source_pdf(self):
        target = Path(os.environ["WORKBENCH_DATA_DIR"]) / "中文样本.pdf"
        shutil.copyfile(flow.FIXTURES / "quartz_alpha.pdf", target)
        return target

    def test_language_detector_uses_body_ratio_not_chinese_title_or_abstract(self):
        chinese = ("研究显示实验结果支持该结论。" * 25) + ("样本数量137，方法可靠。" * 15)
        english = "This English paper presents the results and method. " * 80
        self.assertEqual(detect_source_language([chinese, chinese]), "zh")
        self.assertEqual(detect_source_language(["中文标题：实验方法", "中文摘要。" * 5, english]), "en")
        mixed = ("本研究比较两种方法。" * 15) + ("This paper compares methods. " * 5)
        self.assertEqual(detect_source_language([mixed]), "unknown")

    def test_scanned_document_remains_unclassified_and_blocked(self):
        result = extract_pdf(flow.FIXTURES / "no_text_page.pdf")
        self.assertEqual(result["source_language"], "unknown")
        self.assertTrue(result["has_blocker"])
        self.assertFalse(result["segments"])

    def test_chinese_import_is_readable_from_original_without_translation_or_engine(self):
        source = self.source_pdf()
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        with patch.object(app, "extract_pdf", return_value=chinese_extraction()), \
             patch.object(app.free_translation.FreeTranslationClient, "translate", side_effect=AssertionError("free translation must not run")), \
             patch.object(app, "run_pdf_engine", side_effect=AssertionError("PDF engine must not run")):
            imported = app.import_pdf(str(source))["paper"]
            initialize()
            loaded = app.paper_view(app.require_paper(imported["id"]))

        self.assertEqual(loaded["source_language"], "zh")
        self.assertEqual(loaded["status"], "completed")
        self.assertTrue(loaded["can_read"])
        self.assertEqual(loaded["chinese_title"], "中文样本研究")
        self.assertTrue(loaded["file_name"].startswith("中文样本研究"))
        self.assertEqual(loaded["mono_pdf_file_name"], "")
        self.assertEqual(loaded["dual_pdf_file_name"], "")
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), source_hash)
        self.assertEqual(app.get_pdf(loaded["id"], "original").media_type, "application/pdf")
        for kind in ("mono", "dual"):
            with self.assertRaises(Exception):
                app.get_pdf(loaded["id"], kind)

    def test_chinese_reader_search_matches_han_words_and_pages(self):
        source = self.source_pdf()
        with patch.object(app, "extract_pdf", return_value=chinese_extraction()):
            paper_id = app.import_pdf(str(source))["paper"]["id"]
        result, sources = app.read_paper_evidence(paper_id, {"query": "实验样本"}, 2)
        self.assertIn("实验样本", result)
        self.assertTrue(sources)
        self.assertEqual(next(iter(sources.values())), {"start_page": 1, "end_page": 2})

    def test_retry_and_worker_guard_recover_old_unknown_chinese_without_api_calls(self):
        source = self.source_pdf()
        with patch.object(app, "extract_pdf", return_value=chinese_extraction()):
            imported = app.import_pdf(str(source))["paper"]
        with connect() as db:
            db.execute("UPDATE papers SET source_language = 'unknown', status = 'error' WHERE id = ?", (imported["id"],))
        with patch.object(app, "extract_pdf", return_value=chinese_extraction()), \
             patch.object(app.free_translation.FreeTranslationClient, "translate", side_effect=AssertionError("no translation call")), \
             patch.object(app, "run_pdf_engine", side_effect=AssertionError("no PDF engine call")):
            retry_result = asyncio.run(app.translation_action(imported["id"], "retry"))
            with connect() as db:
                db.execute("UPDATE papers SET source_language = 'zh', status = 'translating' WHERE id = ?", (imported["id"],))
            asyncio.run(app.translate_paper(imported["id"]))
        self.assertEqual(retry_result["source_language"], "zh")
        self.assertEqual(app.paper_view(app.require_paper(imported["id"]))["status"], "completed")

    def test_reimport_reclassifies_legacy_unknown_duplicate(self):
        source = self.source_pdf()
        with patch.object(app, "extract_pdf", return_value=chinese_extraction()):
            paper = app.import_pdf(str(source))["paper"]
            with connect() as db:
                db.execute("UPDATE papers SET source_language='unknown', status='error' WHERE id=?", (paper["id"],))
            duplicate = app.import_pdf(str(source))
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["paper"]["id"], paper["id"])
        self.assertEqual(duplicate["paper"]["source_language"], "zh")
        self.assertEqual(duplicate["paper"]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
