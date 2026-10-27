"""Run with the PDF-engine Python; exercises the installed Windows OCR engine."""

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

try:
    import pymupdf
except ImportError:
    pymupdf = None

from backend.pdf_engine.local_ocr import recognize_pdf, status


@unittest.skipUnless(sys.platform == "win32" and pymupdf is not None, "requires Windows and the PDF-engine runtime")
class LocalOCREngine(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.available = status()
        if not cls.available.get("available"):
            raise unittest.SkipTest(cls.available.get("error", "Windows OCR is unavailable"))
        cls.tags = {item["tag"] for item in cls.available["languages"]}
        if "en-US" not in cls.tags:
            raise unittest.SkipTest("requires the English Windows OCR language pack")

    def setUp(self):
        environment = patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        os.environ.pop("WORKBENCH_OCR_PAGES", None)
        review = Path(__file__).resolve().parents[1] / ".review"
        review.mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix="windows-ocr-test-", dir=review)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_mixed_pdf_adds_missing_text_and_preserves_source_and_rendering(self):
        source = self.root / "mixed.pdf"
        destination = self.root / "recognized.pdf"
        with pymupdf.open() as document:
            native = document.new_page(width=480, height=220)
            native.insert_text((30, 80), "NATIVE SAMPLE PAGE", fontsize=26)
            with pymupdf.open() as raster_source:
                raster = raster_source.new_page(width=520, height=240)
                raster.insert_text((30, 90), "RASTER SAMPLE PAGE", fontsize=28)
                image = raster.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
                page = document.new_page(width=520, height=240)
                page.insert_image(page.rect, pixmap=image)
            with pymupdf.open() as vector_source:
                vector = vector_source.new_page(width=560, height=260)
                vector.insert_text((30, 100), "VECTOR SAMPLE PAGE", fontsize=28)
                svg = vector.get_svg_image(text_as_path=True)
                with pymupdf.open(stream=svg.encode(), filetype="svg") as svg_document:
                    with pymupdf.open(stream=svg_document.convert_to_pdf(), filetype="pdf") as outlined:
                        document.insert_pdf(outlined)
            document.save(source)

        original_bytes = source.read_bytes()
        original_hash = hashlib.sha256(original_bytes).hexdigest()
        with pymupdf.open(source) as document:
            original_text = [page.get_text() for page in document]
            self.assertIn("NATIVE SAMPLE PAGE", original_text[0])
            self.assertEqual(original_text[1:], ["", ""])
            expected = [(page.rect, page.get_pixmap(alpha=False).samples) for page in document]

        progress = []
        self.assertEqual(recognize_pdf(source, destination, "en-US", progress.append), [2, 3])
        self.assertEqual([event["page"] for event in progress], [2, 3])
        self.assertEqual([event["completed"] for event in progress], [1, 2])
        self.assertTrue(all(event["total"] == 2 for event in progress))
        self.assertEqual(source.read_bytes(), original_bytes)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_hash)
        with pymupdf.open(destination) as document:
            self.assertEqual(len(document), 3)
            self.assertEqual(document[0].get_text(), original_text[0])
            self.assertIn("RASTER", document[1].get_text().upper())
            self.assertIn("VECTOR", document[2].get_text().upper())
            for page, (rect, pixels) in zip(document, expected):
                self.assertEqual(page.rect, rect)
                self.assertEqual(page.get_pixmap(alpha=False).samples, pixels)

    def test_chinese_raster_adds_extractable_text_without_visible_changes(self):
        if "zh-Hans-CN" not in self.tags:
            self.skipTest("requires the Simplified Chinese Windows OCR language pack")
        source = self.root / "chinese.pdf"
        destination = self.root / "recognized.pdf"
        phrase = "本地文字识别测试"
        with pymupdf.open() as raster_source:
            page = raster_source.new_page(width=520, height=240)
            page.insert_text((40, 100), phrase, fontname="china-s", fontsize=40)
            image = page.get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
            with pymupdf.open() as document:
                page = document.new_page(width=520, height=240)
                page.insert_image(page.rect, pixmap=image)
                document.save(source)
        original = source.read_bytes()
        with pymupdf.open(source) as document:
            self.assertEqual(document[0].get_text(), "")
            expected_rect = document[0].rect
            expected_pixels = document[0].get_pixmap(alpha=False).samples

        self.assertEqual(recognize_pdf(source, destination, "zh-Hans-CN", lambda event: None), [1])
        self.assertEqual(source.read_bytes(), original)
        with pymupdf.open(destination) as document:
            self.assertEqual(len(document), 1)
            self.assertIn(phrase, "".join(document[0].get_text().split()))
            self.assertEqual(document[0].rect, expected_rect)
            self.assertEqual(document[0].get_pixmap(alpha=False).samples, expected_pixels)

    def test_no_recognized_text_fails_without_publishing_output(self):
        source = self.root / "shapes.pdf"
        destination = self.root / "recognized.pdf"
        with pymupdf.open() as document:
            page = document.new_page(width=400, height=300)
            page.draw_rect(pymupdf.Rect(80, 60, 320, 240), color=(0, 0, 0), fill=(0.5, 0.7, 0.8))
            document.save(source)
        original = source.read_bytes()
        progress = []
        with self.assertRaisesRegex(RuntimeError, "未识别到文字"):
            recognize_pdf(source, destination, "en-US", progress.append)
        self.assertFalse(destination.exists())
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(progress, [])

    def test_unavailable_selected_language_is_rejected(self):
        unavailable = next((tag for tag in ("fr-FR", "ja-JP", "de-DE", "it-IT", "es-ES") if tag not in self.tags), "zz-ZZ")
        destination = self.root / "recognized.pdf"
        with self.assertRaisesRegex(RuntimeError, "语言未安装"):
            recognize_pdf(self.root / "unused.pdf", destination, unavailable, lambda event: None)
        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
