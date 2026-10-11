"""Create isolated PDFs for real Electron notes and cross-view QA."""
import argparse
import os
from pathlib import Path
import shutil

from pypdf import PdfReader
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("data", type=Path)
args = parser.parse_args()
target = args.data.resolve()
assert target.is_relative_to(ROOT / ".review"), "Only isolated review data can be seeded"
assert not (target / "workbench.sqlite").exists(), "Do not overwrite any existing data"

fixtures = target.parent / "fixtures"
fixtures.mkdir(parents=True, exist_ok=True)
source_pdf = fixtures / "notes-upgrade-source.pdf"
mono_pdf = fixtures / "notes-upgrade-mono.pdf"
dual_pdf = fixtures / "notes-upgrade-dual.pdf"

original_one = (
    "SOURCE-QA-ORIGINAL: ZORVEX-Q7 assay records the cobalt response in LANTERN-48. "
    "This original paragraph has a unique source mapping signature."
)
original_two = "MANUAL-ORIGINAL-ANCHOR: inspect calibration for unit QX-77."
translated_one = "独特译段：ZORVEX-Q7 量化 LANTERN-48 的钴响应。"
manual_target = "MANUAL-BILINGUAL-DESTINATION: manually selected target text QY-88."
chinese_font = ROOT / "backend/pdf_engine_assets/babeldoc/fonts/LXGWWenKaiGB-Regular.1.520.ttf"
pdfmetrics.registerFont(TTFont("FolioReviewChinese", str(chinese_font)))


def make_pdf(path: Path, pages: list[list[tuple[str, str]]]) -> None:
    document = canvas.Canvas(str(path), pagesize=letter)
    document.setTitle("Folio Notes and Cross-View QA Fixture")
    for lines in pages:
        y = 740
        for font, text in lines:
            document.setFont(font, 10)
            document.drawString(42, y, text)
            y -= 32
        document.showPage()
    document.save()


make_pdf(source_pdf, [
    [("Helvetica", "Folio isolated source page 1"), ("Helvetica", original_one)],
    [("Helvetica", "Folio isolated source page 2"), ("Helvetica", original_two)],
])
make_pdf(mono_pdf, [
    [("FolioReviewChinese", "中文验收封面：仅用于隔离测试。")],
    [("FolioReviewChinese", "中文第二页：不包含目标译段。")],
    [("FolioReviewChinese", translated_one)],
])
make_pdf(dual_pdf, [
    [("Helvetica", original_one), ("FolioReviewChinese", "双语对照：验证英文引文高亮。")],
    [("Helvetica", manual_target), ("FolioReviewChinese", "手动关联目标位于双语 PDF 第二页。")],
])

for path, expected_pages in ((source_pdf, 2), (mono_pdf, 3), (dual_pdf, 2)):
    reader = PdfReader(path)
    assert len(reader.pages) == expected_pages, f"Unexpected page count for {path.name}"
    assert all(page.extract_text() for page in reader.pages), f"Fixture pages must have a PDF text layer: {path.name}"

os.environ["WORKBENCH_DATA_DIR"] = str(target)
from backend import app
from backend.db import connect, initialize

initialize()
paper = app.import_pdf(str(source_pdf))["paper"]
paper_id = paper["id"]
folder = app.pdf_path(app.require_paper(paper_id)).parent
shutil.copy2(mono_pdf, folder / "notes-upgrade-mono.pdf")
shutil.copy2(dual_pdf, folder / "notes-upgrade-dual.pdf")
with connect() as db:
    db.execute(
        "UPDATE papers SET english_title=?, chinese_title=?, source_language='en', status='completed', "
        "mono_pdf_file_name='notes-upgrade-mono.pdf', dual_pdf_file_name='notes-upgrade-dual.pdf', "
        "pdf_progress=100 WHERE id=?",
        ("Folio Notes Upgrade Fixture", "笔记与跨视图 QA 文献", paper_id),
    )
    db.execute("DELETE FROM segments WHERE paper_id=?", (paper_id,))
    db.executemany(
        "INSERT INTO segments(paper_id, sequence_no, start_page, end_page, original_text, translation, status) "
        "VALUES (?, ?, ?, ?, ?, ?, 'completed')",
        [
            (paper_id, 1, 1, 1, original_one, translated_one),
            (paper_id, 2, 2, 2, original_two, "第二段用于手动关联验收。"),
        ],
    )
    db.execute("UPDATE pages SET extraction_status='text' WHERE paper_id=?", (paper_id,))

print(f"{paper_id}\t{source_pdf}\t{mono_pdf}\t{dual_pdf}")
