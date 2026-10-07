"""Check deletion boundaries against isolated library data and real endpoints."""
import asyncio
import hashlib
import os
from pathlib import Path
import tempfile
import sys
import threading
import re
import unittest
from unittest.mock import patch
import httpx
from backend import app
from backend.db import connect, initialize, library_root
from review.paths import FIXTURE_ROOT, REVIEW_ROOT

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = FIXTURE_ROOT

class DeleteContractReview(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=REVIEW_ROOT)
        self.environment = patch.dict(os.environ, {'WORKBENCH_DATA_DIR': self.temporary.name, 'WORKBENCH_SESSION_TOKEN': 'delete-review-token'})
        self.environment.start()
        initialize()
        app.worker_wakeup = asyncio.Event()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    async def delete(self, paper_id, token='delete-review-token'):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url='http://test') as client:
            return await client.delete(f'/papers/{paper_id}', headers={'Authorization': f'Bearer {token}'})

    def test_deletion_removes_library_pdf_and_chat_preserves_source_and_other_paper(self):
        source = FIXTURES / 'quartz_alpha.pdf'
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        target = app.import_pdf(str(source))['paper']['id']
        other = app.import_pdf(str(FIXTURES / 'quartz_beta_same_title.pdf'))['paper']['id']
        folder = library_root() / target
        (folder / 'translated.mono.pdf').write_bytes(source.read_bytes())
        (folder / 'translated.dual.pdf').write_bytes(source.read_bytes())
        app.add_chat_message(target, 'user', 'test question')
        app.store_status(target, 'translating')
        result = asyncio.run(self.delete(target))
        self.assertEqual(result.status_code, 200, result.text)
        self.assertFalse(folder.exists())
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), digest)
        self.assertTrue((library_root() / other).exists())
        self.assertEqual(app.require_paper(other)['status'], 'queued')
        with connect() as db:
            for table in ('papers', 'pages', 'segments', 'chat_messages', 'paper_glossary', 'analysis_runs'):
                column = 'id' if table == 'papers' else 'paper_id'
                self.assertEqual(db.execute(f'SELECT COUNT(*) FROM {table} WHERE {column}=?', (target,)).fetchone()[0], 0)
        self.assertEqual(asyncio.run(self.delete(target)).status_code, 404)

    def test_bad_session_and_unknown_id_cannot_delete_another_document(self):
        target = app.import_pdf(str(FIXTURES / 'quartz_alpha.pdf'))['paper']['id']
        folder = library_root() / target
        self.assertEqual(asyncio.run(self.delete(target, 'wrong-token')).status_code, 401)
        self.assertEqual(asyncio.run(self.delete('untrusted-id')).status_code, 404)
        self.assertTrue(folder.exists())
        self.assertIsNotNone(app.require_paper(target))

    def test_delete_terminates_only_target_helper_and_prevents_late_completion(self):
        from review.test_translation_flow import FixtureFreeClient, fixture_pdf_engine
        target = app.import_pdf(str(FIXTURES / 'quartz_alpha.pdf'))['paper']['id']
        other = app.import_pdf(str(FIXTURES / 'quartz_beta_same_title.pdf'))['paper']['id']
        helper = Path(self.temporary.name) / 'slow_helper.py'
        helper.write_text("import time,json\nprint(json.dumps({'type':'progress','progress':10}),flush=True)\ntime.sleep(60)\n", encoding='utf-8')

        async def exercise():
            app.store_status(target, 'translating')
            task = asyncio.create_task(app.translate_paper(target))
            process = None
            for _ in range(100):
                process = app.pdf_processes.get(target)
                if process is not None:
                    break
                await asyncio.sleep(.03)
            self.assertIsNotNone(process, 'helper must actually start before deletion')
            response = await self.delete(target)
            self.assertEqual(response.status_code, 200, response.text)
            await asyncio.wait_for(task, timeout=10)
            self.assertIsNotNone(process.returncode, 'deleted paper helper must not survive')
            self.assertNotIn(target, app.pdf_processes)
            self.assertFalse((library_root() / target).exists())
            with patch.object(app, 'run_pdf_engine', fixture_pdf_engine):
                app.store_status(other, 'translating')
                await app.translate_paper(other)
            self.assertTrue(app.paper_view(app.require_paper(other))['can_read'])

        with patch.object(app.free_translation, 'FreeTranslationClient', FixtureFreeClient), patch.dict(os.environ, {'WORKBENCH_PDF_ENGINE_BIN': sys.executable, 'WORKBENCH_PDF_ENGINE_ENTRY': str(helper), 'WORKBENCH_PDF_ENGINE_ASSETS': self.temporary.name}):
            asyncio.run(exercise())

    def test_delete_cancels_inflight_summary_without_recreating_chat(self):
        from review.test_translation_flow import FixtureFreeClient, fixture_pdf_engine
        target = app.import_pdf(str(FIXTURES / 'quartz_alpha.pdf'))['paper']['id']
        started, release = threading.Event(), threading.Event()

        def delayed_answer(messages, **kwargs):
            if kwargs.get('tools') and messages[-1]['role'] != 'tool':
                return {'content': '', 'tool_calls': [{'id': 'summary_delete', 'type': 'function', 'function': {'name': 'summarize_paper', 'arguments': '{}'}}], 'usage': None}
            started.set()
            release.wait(5)
            evidence = '\n'.join(message['content'] for message in messages)
            source = re.search(r'\[(S\d+)\]', evidence).group(1)
            return {'content': f'测试总结 [{source}]', 'usage': None}

        async def exercise():
            app.store_status(target, 'translating')
            await app.translate_paper(target)
            task = asyncio.create_task(app.chat(target, app.ChatInput(question='详细总结一下这篇文献')))
            try:
                for _ in range(100):
                    if started.is_set():
                        break
                    await asyncio.sleep(.02)
                self.assertTrue(started.is_set())
                response = await self.delete(target)
                self.assertEqual(response.status_code, 200, response.text)
                with self.assertRaises(asyncio.CancelledError):
                    await task
                release.set()
                await asyncio.sleep(.05)
                with connect() as db:
                    self.assertEqual(db.execute('SELECT COUNT(*) FROM chat_messages WHERE paper_id=?', (target,)).fetchone()[0], 0)
                self.assertFalse((library_root() / target).exists())
            finally:
                release.set()
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)

        with patch.object(app.free_translation, 'FreeTranslationClient', FixtureFreeClient), patch.object(app, 'run_pdf_engine', fixture_pdf_engine), patch.object(app.ai, 'current_config', return_value=('http://127.0.0.1:9999/test', 'review-model', 'review-only-key')), patch.object(app.ai, 'chat_completion', delayed_answer):
            asyncio.run(exercise())

if __name__ == '__main__':
    unittest.main()
