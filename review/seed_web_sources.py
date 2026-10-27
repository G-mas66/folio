"""Seed historical chat source pollution only in an isolated review database."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
target = Path(sys.argv[1]).resolve()
assert target.is_relative_to(ROOT / '.review')
assert not (target / 'workbench.sqlite').exists()
seed = subprocess.run([sys.executable, '-m', 'review.seed_compact_library', str(target)], cwd=ROOT, capture_output=True, text=True, check=True)
paper = json.loads(seed.stdout)[0]
os.environ['WORKBENCH_DATA_DIR'] = str(target)
from backend.db import connect, initialize
from backend.app import now

initialize()
main_session, other_session = uuid.uuid4().hex, uuid.uuid4().hex
paper_source = {'id': 'S1', 'start_page': 1, 'end_page': 1}
def web(source_id, title, url):
    return {'id': source_id, 'kind': 'web', 'start_page': 0, 'end_page': 0, 'title': title, 'url': url}

with connect() as db:
    db.execute('DELETE FROM chat_sessions WHERE paper_id=?', (paper['id'],))
    db.executemany('INSERT INTO chat_sessions(id,paper_id,title,is_default,created_at) VALUES (?,?,?,?,?)', [
        (main_session, paper['id'], '历史来源核验', 1, now()),
        (other_session, paper['id'], '另一会话', 0, now()),
    ])
    entries = [
        (main_session, 'user', 'gene2vec 在论文中解决了什么问题？', []),
        (main_session, 'assistant', '历史回答仅引用论文。gene2vec 表示基因之间的关系。[S1]', [paper_source,
            web('W1', 'DeepSeek unrelated historical result', 'https://example.org/unrelated-deepseek'),
            web('W2', 'Credit card unrelated historical result', 'https://example.org/unrelated-credit-card')]),
        (main_session, 'user', '请结合 gene2vec 的网页来源解释。', []),
        (main_session, 'assistant', '引用网页回答：gene2vec 使用共表达信息。[W1] 论文依据仍保留。[S1]', [paper_source,
            web('W1', 'Gene2vec cited research page', 'https://example.org/gene2vec-cited'),
            web('W2', 'Unused finance result', 'https://example.org/unused-finance')]),
        (other_session, 'user', '另一会话的独立网页是什么？', []),
        (other_session, 'assistant', '独立会话只引用自己的网页。[W1]', [web('W1', 'Other session cited page', 'https://example.org/other-session')]),
    ]
    db.executemany('INSERT INTO chat_messages(paper_id,session_id,role,content,sources_json,created_at) VALUES (?,?,?,?,?,?)',
                   [(paper['id'], session, role, text, json.dumps(sources), now()) for session, role, text, sources in entries])
print(json.dumps({'paper_id': paper['id'], 'main_session': main_session, 'other_session': other_session}))
