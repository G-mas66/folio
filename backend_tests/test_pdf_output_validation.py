"""Generated PDF geometry and completeness checks, without the user's library."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import FloatObject, NameObject, RectangleObject

from backend.app import validate_pdf_outputs


class PDFOutputValidation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def pdf(self, name, *, size=(595.276, 841.89), rotation=0, crop=None, unit=1, count=2):
        writer = PdfWriter()
        for _ in range(count):
            page = writer.add_blank_page(width=size[0], height=size[1])
            page.rotate(rotation)
            if crop:
                page.cropbox = RectangleObject(crop)
            page[NameObject("/UserUnit")] = FloatObject(unit)
        path = self.root / name
        writer.write(path)
        return path

    def validate(self, source, mono, dual, expected=2):
        # Geometry fixtures contain no body; text detection has its own rejection test.
        with patch("pypdf._page.PageObject.extract_text", return_value="中文译文正文"):
            validate_pdf_outputs(source, mono, dual, expected)

    def test_rotation_and_normalized_mono_match_visible_geometry(self):
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                source = self.pdf("source.pdf", rotation=rotation)
                size = (841.89, 595.276) if rotation % 180 else (595.276, 841.89)
                mono = self.pdf("mono.pdf", size=size)
                dual = self.pdf("dual.pdf", size=(size[0] * 2, size[1]))
                self.validate(source, mono, dual)

    def test_crop_and_user_unit_determine_visible_size(self):
        source = self.pdf("source.pdf", crop=(20, 30, 500, 700), unit=2, rotation=90)
        mono = self.pdf("mono.pdf", size=(1340, 960))
        dual = self.pdf("dual.pdf", size=(2680, 960))
        self.validate(source, mono, dual)

    def test_missing_and_extra_pages_are_rejected(self):
        source = self.pdf("source.pdf")
        for mono_count, dual_count in ((1, 2), (2, 1), (3, 2), (2, 3), (0, 2)):
            with self.subTest(mono_count=mono_count, dual_count=dual_count):
                mono = self.pdf("mono.pdf", count=mono_count)
                dual = self.pdf("dual.pdf", size=(1190.552, 841.89), count=dual_count)
                with self.assertRaisesRegex(ValueError, "页数无效"):
                    self.validate(source, mono, dual)

    def test_wrong_layout_and_ignored_rotation_are_rejected(self):
        source = self.pdf("source.pdf", rotation=90)
        mono = self.pdf("mono.pdf", rotation=90)
        for size in ((1190.552, 841.89), (841.89, 1190.552), (841.89, 595.276)):
            with self.subTest(size=size), self.assertRaisesRegex(ValueError, "双语 PDF"):
                self.validate(source, mono, self.pdf("dual.pdf", size=size))

    def test_wrong_mono_size_and_empty_translation_are_rejected(self):
        source = self.pdf("source.pdf")
        mono = self.pdf("mono.pdf")
        dual = self.pdf("dual.pdf", size=(1190.552, 841.89))
        with self.assertRaisesRegex(ValueError, "中文 PDF 未检测"):
            validate_pdf_outputs(source, mono, dual, 2)
        with self.assertRaisesRegex(ValueError, "中文 PDF 页面尺寸"):
            self.validate(source, self.pdf("wrong.pdf", size=(400, 600)), dual)


if __name__ == "__main__":
    unittest.main()
