"""Create a native-text plus raster-only PDF inside an isolated review library."""
import json
import os
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

ROOT = Path(__file__).resolve().parents[1]
target = Path(sys.argv[1]).resolve()
assert target.is_relative_to(ROOT / '.review')
assert not (target / 'workbench.sqlite').exists()
os.environ['WORKBENCH_DATA_DIR'] = str(target)

from backend import app
from backend.db import connect, initialize

initialize()
fixtures = target.parent / 'fixtures'
fixtures.mkdir(parents=True, exist_ok=True)
source = fixtures / 'mixed-native-raster.pdf'
document = canvas.Canvas(str(source), pagesize=(595, 842))
document.setTitle('Local OCR integration experiment')
document.setFont('Helvetica-Bold', 18)
document.drawString(48, 780, 'Local OCR integration experiment')
document.setFont('Helvetica', 12)
for index, line in enumerate([
    'This document evaluates offline optical character recognition.',
    'The first page contains ordinary selectable native PDF text.',
    'The second page contains an image with English research text.',
    'Local recognition should recover the image text before translation.',
    'The original document must remain available throughout processing.',
    'Recognition is performed on this computer without a paid service.',
]):
    document.drawString(48, 730 - index * 28, line)
document.showPage()
image = Image.new('RGB', (1190, 1684), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 26)
for index, line in enumerate([
    'Optical character recognition experiment',
    'This page is a raster image with no native text.',
    'We tested a local recognition engine on printed English.',
    'The method extracts words before document translation.',
    'The recognized text should preserve the study results.',
    'Accuracy improves when letters are clear and well spaced.',
    'The source document remains unchanged after recognition.',
    'This synthetic example contains no private research data.',
]):
    draw.text((96, 150 + index * 64), line, fill='black', font=font)
document.drawImage(ImageReader(image), 0, 0, width=595, height=842)
document.showPage()
document.save()
paper = app.import_pdf(str(source))['paper']
with connect() as db:
    db.execute("INSERT INTO settings(id, base_url, model, ocr_enabled, ocr_language, updated_at) VALUES (1, '', '', 0, 'auto', ?) ON CONFLICT(id) DO UPDATE SET ocr_enabled=0, ocr_language='auto'", (app.now(),))
    db.execute("UPDATE papers SET status='needs_attention', error='第 2 页需要本地 OCR。', chinese_title='本地文字识别验收', title_confident=1, source_language='en', mono_pdf_file_name='', dual_pdf_file_name='', pdf_progress=0 WHERE id=?", (paper['id'],))
assert app.paper_view(app.require_paper(paper['id']))['ocr_pages'] == []
print(json.dumps({'id': paper['id'], 'source': str(app.pdf_path(app.require_paper(paper['id'])))}))
