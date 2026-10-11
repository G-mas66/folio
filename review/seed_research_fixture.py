"""Create a deterministic two-page PDF only under the isolated review directory."""
import argparse
import json
import os
from pathlib import Path

from reportlab.pdfgen import canvas

parser = argparse.ArgumentParser()
parser.add_argument('data', type=Path)
target = parser.parse_args().data.resolve()
root = Path(__file__).resolve().parents[1]
assert target.is_relative_to(root / '.review'), 'Only isolated review data can be seeded'
assert not (target / 'workbench.sqlite').exists(), 'Do not overwrite existing data'
os.environ['WORKBENCH_DATA_DIR'] = str(target)
os.environ['WORKBENCH_FREE_API_URL'] = ''
from backend import app
from backend.db import initialize, connect

source = target.parent / 'fixtures' / 'research.pdf'
source.parent.mkdir(parents=True, exist_ok=True)
document = canvas.Canvas(str(source))
document.setTitle('Research integration fixture')
for page in range(1, 3):
    document.drawString(48, 760, 'Research integration fixture')
    document.drawString(48, 720, f'Page {page}: The study uses 137 independent samples.')
    document.drawString(48, 680, 'Independent observations reduce dependence between measurements.')
    document.showPage()
document.save()
initialize()
paper = app.import_pdf(str(source))['paper']
session = app.ensure_chat_session(paper['id'])
# The integration fixture reuses its PDF for all views; it does not claim translation quality.
with connect() as db:
    db.execute("UPDATE papers SET status = 'completed', mono_pdf_file_name = file_name, dual_pdf_file_name = file_name, pdf_progress = 100 WHERE id = ?", (paper['id'],))
    for index in range(5):
        for role, content in [('user', f'Navigation fixture question {index + 1}'), ('assistant', ('Fixture answer for scrolling. ' * 80))]:
            db.execute("INSERT INTO chat_messages(paper_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                       (paper['id'], session['id'], role, content, app.now()))
print(json.dumps({'paper_id': paper['id'], 'source': str(source), 'pages': 2}))
