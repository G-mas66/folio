"""Text-only records must be upgraded to real PDFs before opening a reader."""
import asyncio
import unittest
from unittest.mock import patch
from backend import app
from backend.db import connect, initialize
from review import test_translation_flow as flow

class PDFUpgradeReview(unittest.TestCase):
    setUp = flow.TranslationFlowReview.setUp
    tearDown = flow.TranslationFlowReview.tearDown

    def test_legacy_text_completion_is_requeued_and_original_body_survives(self):
        paper_id = app.import_pdf(str(flow.FIXTURES / 'quartz_alpha.pdf'))['paper']['id']
        with connect() as db:
            db.execute("UPDATE papers SET status='completed', chinese_title='旧版标题' WHERE id=?", (paper_id,))
            db.execute("UPDATE segments SET status='completed', translation='旧版纯文字译文' WHERE paper_id=?", (paper_id,))
            before = [tuple(row) for row in db.execute('SELECT id, original_text FROM segments WHERE paper_id=?', (paper_id,))]
        self.assertFalse(app.paper_view(app.require_paper(paper_id))['can_read'])

        async def idle_queue():
            await asyncio.Event().wait()

        async def restart():
            with patch.object(app, 'queue_loop', idle_queue):
                await app.startup()
                try:
                    state = app.require_paper(paper_id)['status']
                    self.assertEqual(state, 'queued')
                finally:
                    await app.shutdown()

        asyncio.run(restart())
        with connect() as db:
            after = [tuple(row) for row in db.execute('SELECT id, original_text FROM segments WHERE paper_id=?', (paper_id,))]
        self.assertEqual(before, after)

    def test_03_schema_gets_model_fields_without_changing_library_or_chat(self):
        paper_id = app.import_pdf(str(flow.FIXTURES / 'quartz_alpha.pdf'))['paper']['id']
        app.add_chat_message(paper_id, 'user', '已有阅读记录')
        with connect() as db:
            db.execute("INSERT INTO settings(id,base_url,model,updated_at) VALUES(1,'http://127.0.0.1:9999/custom/?route=literal','old-model',?)", (app.now(),))
            db.execute('ALTER TABLE papers DROP COLUMN model_override')
            db.execute('ALTER TABLE settings DROP COLUMN model_options_json')
            db.execute('ALTER TABLE analysis_runs DROP COLUMN model_snapshot')
            original = [tuple(row) for row in db.execute('SELECT id,original_text FROM segments WHERE paper_id=?', (paper_id,))]
        initialize()
        with connect() as db:
            paper = db.execute('SELECT id,model_override FROM papers WHERE id=?', (paper_id,)).fetchone()
            settings = db.execute('SELECT model,base_url,model_options_json FROM settings WHERE id=1').fetchone()
            self.assertEqual(tuple(paper), (paper_id, ''))
            self.assertEqual(tuple(settings), ('old-model', 'http://127.0.0.1:9999/custom/?route=literal', '[]'))
            self.assertIn('model_snapshot', {row['name'] for row in db.execute('PRAGMA table_info(analysis_runs)')})
            self.assertEqual(original, [tuple(row) for row in db.execute('SELECT id,original_text FROM segments WHERE paper_id=?', (paper_id,))])
        self.assertEqual(app.get_chat(paper_id)[0]['content'], '已有阅读记录')

if __name__ == '__main__':
    unittest.main()
