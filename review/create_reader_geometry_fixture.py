"""Seed isolated original, Chinese-only, and bilingual PDFs for reader geometry tests."""
import argparse
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
args = parser.parse_args()
output = args.output.resolve()
assert output.is_relative_to(ROOT / ".review"), "Fixture output must stay under .review"
data = output / "data"
data.mkdir(parents=True, exist_ok=True)
assert not (data / "workbench.sqlite").exists(), "Refusing to overwrite review data"
os.environ["WORKBENCH_DATA_DIR"] = str(data)
sys.path.insert(0, str(ROOT))

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from pypdf import PdfReader, PdfWriter

from backend import app
from backend.db import connect, initialize


font_path = ROOT / "backend/pdf_engine_assets/babeldoc/fonts/LXGWWenKaiGB-Regular.1.520.ttf"
pdfmetrics.registerFont(TTFont("ReaderGeometryChinese", str(font_path)))
font_size = 12


def draw_pdf(path: Path, bilingual: bool = False, chinese_only: bool = False) -> None:
    page_size = (A4[0] * 2, A4[1]) if bilingual else A4
    doc = canvas.Canvas(str(path), pagesize=page_size)
    doc.setTitle("Reader Geometry Fixture")
    doc.setFont("ReaderGeometryChinese", font_size)
    left_x, right_x = 44, (A4[0] + 44 if bilingual else 307)
    title = "中文双栏定位与选区验收标题跨越列沟用于验证阅读顺序"
    doc.drawString(left_x, 802, title * (3 if bilingual else 1))
    for row in range(16):
        baseline = 760 - row * 15 - (64 if row >= 7 else 0)
        if row == 3:
            first = "同行多段文本"
            doc.drawString(left_x, baseline, first)
            first_width = pdfmetrics.stringWidth(first, "ReaderGeometryChinese", font_size)
            doc.drawString(left_x + first_width + 8, baseline, "用于检查")
            bridge_x = left_x + first_width - 1.5
            doc.drawString(bridge_x, baseline, "高亮重叠")
            right_text = "Right column row 4: overlap check" if bilingual else "右栏第4行：中文高亮验收。"
            doc.drawString(right_x, baseline, right_text)
        elif chinese_only:
            doc.drawString(left_x, baseline, f"左栏第{row + 1}行：医学图像分析。")
            doc.drawString(right_x, baseline, f"右栏第{row + 1}行：中文单语验收。")
        elif bilingual:
            doc.drawString(left_x, baseline, f"Left column row {row + 1}: medical image analysis.")
            doc.drawString(right_x, baseline, f"双语右栏第{row + 1}行：中文标记验证。")
        else:
            doc.drawString(left_x, baseline, f"左栏第{row + 1}行：医学图像AI分析。")
            doc.drawString(right_x, baseline, f"右栏第{row + 1}行：中文高亮验收。")
    footer = "页脚跨越两栏分隔线用于验证跨栏阅读顺序和页面几何"
    doc.drawString(left_x, 38, footer * (2 if bilingual else 1))
    doc.showPage()
    doc.setPageSize(page_size)
    doc.setFont("ReaderGeometryChinese", font_size)
    doc.drawString(left_x, 760, "旋转页面中文字符对齐验证。")
    doc.drawString(left_x, 734, "相邻标记之间不能相互覆盖。")
    if bilingual:
        doc.drawString(A4[0] + 44, 760, "Rotated Latin text remains selectable.")
    doc.showPage()
    doc.setPageSize(page_size)
    doc.setFont("Helvetica", 8)
    for index in range(520):
        doc.drawString(left_x + index * 0.18, 700, "x")
    doc.showPage()
    doc.save()

    reader = PdfReader(str(path))
    reader.pages[1].rotate(90)
    rotated = path.with_name(path.stem + "-rotated.pdf")
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    with rotated.open("wb") as file:
        writer.write(file)
    rotated.replace(path)


output.mkdir(parents=True, exist_ok=True)
original = output / "reader-original.pdf"
mono = output / "reader-mono.pdf"
dual = output / "reader-dual.pdf"
draw_pdf(original)
draw_pdf(mono, chinese_only=True)
draw_pdf(dual, bilingual=True)

initialize()
paper = app.import_pdf(str(original))["paper"]
folder = app.pdf_path(app.require_paper(paper["id"])).parent
mono_name, dual_name = "review-mono.pdf", "review-dual.pdf"
shutil.copy2(mono, folder / mono_name)
shutil.copy2(dual, folder / dual_name)
with connect() as db:
    db.execute(
        "UPDATE papers SET source_language='en', english_title='Reader Geometry Fixture', chinese_title='中文双栏几何验收', title_confident=1, status='completed', error='', mono_pdf_file_name=?, dual_pdf_file_name=?, pdf_progress=100 WHERE id=?",
        (mono_name, dual_name, paper["id"]),
    )
print('{"paper_id":"' + paper["id"] + '","pages":' + str(paper["page_count"]) + '}')
