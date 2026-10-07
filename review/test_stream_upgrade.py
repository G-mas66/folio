"""Legacy conversation/settings migration must preserve records and configuration."""
import asyncio
import unittest

from backend import app
from backend.db import connect, initialize
from review import test_translation_flow as flow


class StreamUpgradeReview(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)

    def tearDown(self):
        flow.TranslationFlowReview.tearDown(self)

    def test_actual_legacy_columns_upgrade_preserves_chat_and_settings(self):
        paper = app.import_pdf(str(flow.FIXTURES / 'quartz_alpha.pdf'))['paper']['id']
        app.store_status(paper, 'translating')
        asyncio.run(app.translate_paper(paper))
        app.add_chat_message(paper, 'user', '旧问题')
        app.add_chat_message(paper, 'assistant', '旧答案')
        with connect() as db:
            db.execute("INSERT INTO settings(id,base_url,model,model_options_json,updated_at) VALUES (1,'https://provider.example/custom/?route=keep','legacy-model','[\"legacy-model\"]','review-date')")
            old_records = [dict(row) for row in db.execute('SELECT id,paper_id,role,content,sources_json,created_at FROM chat_messages ORDER BY id')]
            for column in ('reasoning', 'status', 'error'):
                db.execute(f'ALTER TABLE chat_messages DROP COLUMN {column}')
            db.execute('ALTER TABLE settings DROP COLUMN web_search_enabled')
        initialize()
        with connect() as db:
            records = [dict(row) for row in db.execute('SELECT id,paper_id,role,content,sources_json,created_at FROM chat_messages ORDER BY id')]
            settings = dict(db.execute('SELECT base_url,model,model_options_json,web_search_enabled FROM settings WHERE id=1').fetchone())
        self.assertEqual(records, old_records)
        self.assertEqual(settings['base_url'], 'https://provider.example/custom/?route=keep')
        self.assertEqual(settings['model'], 'legacy-model')
        self.assertEqual(settings['model_options_json'], '["legacy-model"]')
        self.assertTrue(settings['web_search_enabled'])
        for message in app.get_chat(paper):
            self.assertEqual(message['reasoning'], '')
            self.assertEqual(message['status'], 'completed')
            self.assertEqual(message['error'], '')


if __name__ == '__main__':
    unittest.main()
