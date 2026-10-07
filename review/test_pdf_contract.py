"""Review whole-document extraction and title confidence using real PDFs."""

from pathlib import Path
import shutil
import tempfile
import unittest

from backend.pdf_extract import extract_pdf


FIXTURES = Path(__file__).resolve().parents[1] / ".review" / "fixtures"


class PDFContractReview(unittest.TestCase):
    def test_visible_unextractable_page_blocks_full_completion(self):
        result = extract_pdf(FIXTURES / "mixed_text_and_unextractable.pdf")
        self.assertTrue(result["has_blocker"])
        self.assertNotEqual(result["pages"][1]["status"], "blank")

    def test_export_metadata_is_not_a_confident_paper_title(self):
        result = extract_pdf(FIXTURES / "wrong_metadata_title.pdf")
        if result["title_confident"]:
            self.assertEqual(result["english_title"], "The Actual Quartz Measurement Study")
        self.assertNotEqual(result["english_title"], "Generic Export Document")

    def test_existing_title_filename_does_not_turn_authors_into_title(self):
        with tempfile.TemporaryDirectory(dir=FIXTURES.parent) as temporary:
            path = Path(temporary) / "The Actual Quartz Measurement Study.pdf"
            shutil.copyfile(FIXTURES / "wrong_metadata_title.pdf", path)
            result = extract_pdf(path)
        if result["title_confident"]:
            self.assertEqual(result["english_title"], "The Actual Quartz Measurement Study")
        self.assertNotEqual(result["english_title"], "Alice Example and Bob Example")

    def test_all_late_section_facts_are_preserved(self):
        result = extract_pdf(FIXTURES / "quartz_alpha.pdf")
        self.assertFalse(result["has_blocker"])
        text = " ".join(segment["original_text"] for segment in result["segments"])
        for marker in ("QUARTZ_METHOD_N=137", "QUARTZ_RESULT_DELTA=23.7%", "QUARTZ_APPENDIX_SEED=811"):
            self.assertIn(marker, text)
        self.assertEqual({segment["start_page"] for segment in result["segments"]}, {1, 2, 3, 4})

    def test_long_document_retains_every_page(self):
        result = extract_pdf(FIXTURES / "long_paper.pdf")
        self.assertFalse(result["has_blocker"])
        self.assertEqual(result["page_count"], 24)
        text = " ".join(segment["original_text"] for segment in result["segments"])
        for page in range(1, 25):
            self.assertIn(f"COVERAGE_PAGE_{page:02d}", text)


if __name__ == "__main__":
    unittest.main()
