"""Add a second, distinct verified PDF only to isolated tab-review data."""
import argparse
import json
import os
from pathlib import Path
import shutil

from pypdf import PdfReader, PdfWriter, Transformation

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('data', type=Path)
args = parser.parse_args()
target = args.data.resolve()
assert target.is_relative_to(ROOT / '.review')
assert (target / 'workbench.sqlite').exists(), 'Seed the first paper before this helper'
os.environ['WORKBENCH_DATA_DIR'] = str(target)
from backend import app
from backend.db import connect

source = ROOT / '.review/fixtures/quartz_beta_same_title.pdf'
original = PdfReader(source)
fixture = target.parent / 'fixtures'
fixture.mkdir(parents=True, exist_ok=True)
mono = fixture / 'tabs-second-mono.pdf'
dual = fixture / 'tabs-second-dual.pdf'
writer = PdfWriter()
for page in original.pages:
    writer.add_page(page)
writer.write(mono)
writer = PdfWriter()
for page in original.pages:
    width, height = float(page.mediabox.width), float(page.mediabox.height)
    added = writer.add_blank_page(width=width * 2, height=height)
    added.merge_page(page)
    added.merge_transformed_page(page, Transformation().translate(tx=width))
writer.write(dual)

paper = app.import_pdf(str(source))['paper']
folder = app.pdf_path(app.require_paper(paper['id'])).parent
for kind, path in [('mono', mono), ('dual', dual)]:
    shutil.copy2(path, folder / f'tabs-{kind}.pdf')
with connect() as db:
    db.execute("UPDATE papers SET chinese_title='第二篇隔离验收文献', status='completed', mono_pdf_file_name='tabs-mono.pdf', dual_pdf_file_name='tabs-dual.pdf', pdf_progress=100 WHERE id=?", (paper['id'],))
print(json.dumps({'paper_id': paper['id'], 'source': str(source), 'pages': len(original.pages)}))
