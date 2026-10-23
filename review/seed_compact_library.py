"""Create synthetic PDFs only in an explicitly isolated UI review directory."""
import json
import os
from pathlib import Path
import shutil
import sys

from pypdf import PdfReader, PdfWriter, Transformation
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
target = Path(sys.argv[1]).resolve()
assert target.is_relative_to(ROOT / '.review')
assert not (target / 'workbench.sqlite').exists()
os.environ['WORKBENCH_DATA_DIR'] = str(target)

from backend import app, literature
from backend.db import connect, initialize

initialize()
literature.ensure_tables()
fixtures = target.parent / 'fixtures'
fixtures.mkdir(parents=True, exist_ok=True)
papers = []
for name in ('Alpha', 'Beta', 'Error'):
    source = fixtures / f'compact-{name.lower()}.pdf'
    document = canvas.Canvas(str(source))
    document.setTitle(f'Compact library fixture {name}')
    for page in range(2):
        document.setFont('Helvetica-Bold', 18)
        document.drawString(48, 780, f'Compact library fixture {name}')
        document.setFont('Helvetica', 11)
        for line in range(16):
            document.drawString(48, 735 - line * 24, f'Page {page + 1}, line {line + 1}: this is synthetic interface review content.')
        document.showPage()
    document.save()
    paper = app.import_pdf(str(source))['paper']
    folder = app.pdf_path(app.require_paper(paper['id'])).parent
    shutil.copy2(source, folder / 'fixture-mono.pdf')
    dual = PdfWriter()
    for page in PdfReader(source).pages:
        width, height = float(page.mediabox.width), float(page.mediabox.height)
        combined = dual.add_blank_page(width=width * 2, height=height)
        combined.merge_page(page)
        combined.merge_transformed_page(page, Transformation().translate(tx=width))
    dual.write(folder / 'fixture-dual.pdf')
    with connect() as db:
        db.execute(
            "UPDATE papers SET status=?, error=?, chinese_title=?, title_confident=1, source_language='en', "
            "mono_pdf_file_name='fixture-mono.pdf', dual_pdf_file_name='fixture-dual.pdf', pdf_progress=100 WHERE id=?",
            ('error' if name == 'Error' else 'completed', 'Synthetic translation error for UI review.' if name == 'Error' else '', f'紧凑界面验收文献 {name}', paper['id']),
        )
    papers.append({'id': paper['id'], 'name': name, 'source': str(source)})
print(json.dumps(papers))
