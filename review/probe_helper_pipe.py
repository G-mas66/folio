"""Debug helper JSONL in a subprocess with the same pipes as the desktop app."""
import os
from pathlib import Path
import sqlite3
import subprocess
root = Path.cwd()
test = sorted((root / '.review').glob('pdf-layout-*'), key=lambda path: path.stat().st_mtime)[-1]
data = test / 'data'
db = sqlite3.connect(data / 'workbench.sqlite')
paper_id, name = db.execute('SELECT id,file_name FROM papers LIMIT 1').fetchone()
db.close()
source = data / 'papers' / paper_id / name
env = os.environ.copy()
env['WORKBENCH_PDF_ENGINE_ASSETS'] = str(root / 'backend/pdf_engine_assets/babeldoc')
env['TEMP'] = env['TMP'] = str(test / 'temp')
env.pop('PYTHONIOENCODING', None)
env.pop('PYTHONUTF8', None)
result = subprocess.run([str(root / '.venv-pdf-engine/Scripts/python.exe'), str(root / 'backend/pdf_engine/entrypoint.py'), str(source), str(test / 'probe-output'), str(data / '.pdf-engine-home')], capture_output=True, env=env, timeout=120)
(test / 'helper-stdout.bin').write_bytes(result.stdout)
(test / 'helper-stderr.txt').write_bytes(result.stderr)
print({'exit_code': result.returncode, 'stdout_bytes': len(result.stdout), 'stderr_bytes': len(result.stderr)})
for encoding in ('utf-8', 'gbk'):
    try:
        text = result.stdout.decode(encoding)
        print(encoding, 'decoded', text.splitlines()[-1][-350:])
    except UnicodeDecodeError:
        print(encoding, 'cannot decode output')
print(result.stderr.decode('utf-8', errors='replace')[-1800:])
