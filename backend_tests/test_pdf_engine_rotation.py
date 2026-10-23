"""Run with the PDF-engine Python to verify rotation without invoking translation."""

import hashlib
from pathlib import Path
import tempfile
import unittest

try:
    import pymupdf
except ImportError:
    pymupdf = None

from backend.pdf_engine.entrypoint import normalized_pdf_input


@unittest.skipIf(pymupdf is None, "requires the PDF-engine runtime")
class PDFEngineRotation(unittest.TestCase):
    def test_rotated_input_preserves_rendering_and_original_inside_engine_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            with pymupdf.open() as document:
                for angle in (0, 90, 180, 270):
                    page = document.new_page(width=300, height=500)
                    page.insert_text((30, 60), "Rotation keeps this entire sentence.")
                    page.insert_text((30, 430), "Bottom marker")
                    page.set_cropbox(pymupdf.Rect(10, 20, 290, 480))
                    page.set_rotation(angle)
                    document.xref_set_key(page.xref, "UserUnit", "2")
                document.save(source)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            with pymupdf.open(source) as document:
                expected = [(page.rect, page.get_pixmap().samples) for page in document]
            output = root / "output"
            normalized = normalized_pdf_input(source, output)
            self.assertEqual(normalized, output / ".input" / source.name)
            with pymupdf.open(normalized) as document:
                for page, (rect, pixels) in zip(document, expected):
                    self.assertEqual(page.rotation, 0)
                    self.assertEqual(page.rect, rect)
                    self.assertEqual(page.get_pixmap().samples, pixels)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)

    def test_unrotated_input_uses_source_without_a_temporary_copy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.pdf"
            with pymupdf.open() as document:
                document.new_page()
                document.save(source)
            output = root / "output"
            self.assertEqual(normalized_pdf_input(source, output), source)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
