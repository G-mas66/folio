"""Seed only an explicitly named D-drive review directory with verified test PDFs."""
import argparse
import json
import os
from pathlib import Path
import shutil

from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('data', type=Path)
parser.add_argument('--mixed', action='store_true')
parser.add_argument('--chinese', action='store_true')
args = parser.parse_args()
target = args.data.resolve()
assert target.is_relative_to(ROOT / '.review'), 'Only isolated review data can be seeded'
assert not (target / 'workbench.sqlite').exists(), 'Do not overwrite any existing data'
os.environ['WORKBENCH_DATA_DIR'] = str(target)
from backend import app
from backend.db import initialize, connect

previous = ROOT / '.review/pdf-layout-1791211934565/pdfs'
inputs = {
    'source': ROOT / '.review/fixtures/layout_images.pdf',
    'mono': next(previous.glob('mono-*.pdf')),
    'dual': next(previous.glob('dual-*.pdf')),
}
fixture = target.parent / 'fixtures'
fixture.mkdir(parents=True, exist_ok=True)
paths = {}
for kind, source in inputs.items():
    reader = PdfReader(source)
    writer = PdfWriter()
    for repeat in range(6):
        for page in reader.pages:
            added = writer.add_page(page)
            if args.mixed and repeat in (1, 4):
                added.rotate(90)
    paths[kind] = fixture / f'reader-{kind}.pdf'
    writer.write(paths[kind])

initialize()
paper = app.import_pdf(str(paths['source']))['paper']
folder = app.pdf_path(app.require_paper(paper['id'])).parent
for kind in ('mono', 'dual'):
    shutil.copy2(paths[kind], folder / f'review-{kind}.pdf')
with connect() as db:
    db.execute("UPDATE papers SET chinese_title='连续阅读验收文献', status='completed', mono_pdf_file_name='review-mono.pdf', dual_pdf_file_name='review-dual.pdf', pdf_progress=100 WHERE id=?", (paper['id'],))
result = {'paper_id': paper['id'], 'source': str(paths['source']), 'pages': 12}
if args.chinese:
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    pdfmetrics.registerFont(TTFont('FolioChineseFixture', str(ROOT / 'backend/pdf_engine_assets/babeldoc/fonts/LXGWWenKaiGB-Regular.1.520.ttf')))
    chinese = fixture / 'chinese-paper.pdf'
    document = canvas.Canvas(str(chinese))
    document.setTitle('中文文献导入验收')
    for page in range(2):
        document.setFont('FolioChineseFixture', 16)
        document.drawString(50, 780, '中文文献导入验收')
        document.setFont('FolioChineseFixture', 12)
        for line in range(16):
            document.drawString(50, 730 - line * 32, '这是一篇中文研究文献，用于验证导入后跳过翻译，原始页面内容保持完整。')
        document.rect(50, 90, 120, 50)
        document.showPage()
    document.save()
    result['chinese'] = str(chinese)
print(json.dumps(result))
