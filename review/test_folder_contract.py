"""Independent folder endpoint and legacy-library preservation checks."""
import asyncio
import hashlib
import os
import unittest
from unittest.mock import patch

import httpx
from backend import app
from backend.db import connect, initialize
from review import test_translation_flow as flow


class FolderReview(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.token = patch.dict(os.environ, {'WORKBENCH_SESSION_TOKEN': 'folder-review-token'})
        self.token.start()

    def tearDown(self):
        self.token.stop()
        flow.TranslationFlowReview.tearDown(self)

    def request(self, method, path, body=None, token='folder-review-token'):
        async def call():
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app), base_url='http://test', headers={'Authorization': f'Bearer {token}'}) as client:
                return await client.request(method, path, json=body)
        return asyncio.run(call())

    def folder(self, name='实验设计'):
        result = self.request('POST', '/folders', {'name': name})
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def paper(self, name='quartz_alpha.pdf', folder=None):
        body = {'paths': [str(flow.FIXTURES / name)]}
        if folder:
            body['folder_id'] = folder
        result = self.request('POST', '/papers/import', body)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()['results'][0]

    def test_create_rename_and_persist_folder(self):
        folder = self.folder()
        result = self.request('PATCH', f"/folders/{folder['id']}", {'name': '方法论文'})
        self.assertEqual(result.status_code, 200, result.text)
        initialize()
        found = self.request('GET', '/folders').json()
        self.assertEqual([(item['id'], item['name']) for item in found], [(folder['id'], '方法论文')])

    def test_folder_colors_are_distinct_stable_and_reuse_deleted_color(self):
        folders = [self.folder(f'颜色分类 {index}') for index in range(6)]
        colors = [folder['color'] for folder in folders]
        self.assertEqual(len(set(colors)), len(colors))
        for color in colors:
            self.assertRegex(color, r'^#[0-9a-fA-F]{6}$')
        before = {folder['id']: folder['color'] for folder in folders}
        self.request('PATCH', f"/folders/{folders[0]['id']}", {'name': '改名仍用原色'})
        initialize()
        self.assertEqual({folder['id']: folder['color'] for folder in self.request('GET', '/folders').json()}, before)
        self.request('DELETE', f"/folders/{folders[1]['id']}")
        created = self.folder('替代分类')
        remaining = self.request('GET', '/folders').json()
        self.assertEqual(len({folder['color'] for folder in remaining}), 6)
        self.assertEqual({folder['id']: folder['color'] for folder in remaining if folder['id'] != created['id']}, {key: value for key, value in before.items() if key != folders[1]['id']})

    def test_legacy_folder_color_migration_preserves_identity_documents_and_chat(self):
        folders = [self.folder('旧分类甲'), self.folder('旧分类乙')]
        paper = self.paper(folder=folders[0]['id'])['paper']
        app.add_chat_message(paper['id'], 'user', '迁移颜色前记录')
        original = app.pdf_path(app.require_paper(paper['id']))
        before = hashlib.sha256(original.read_bytes()).hexdigest()
        with connect() as db:
            db.execute('ALTER TABLE folders DROP COLUMN color')
        initialize()
        migrated = self.request('GET', '/folders').json()
        self.assertEqual({(folder['id'], folder['name'], folder['created_at']) for folder in migrated}, {(folder['id'], folder['name'], folder['created_at']) for folder in folders})
        self.assertEqual(len({folder['color'] for folder in migrated}), 2)
        initialize()
        self.assertEqual(self.request('GET', '/folders').json(), migrated)
        self.assertEqual(app.get_paper(paper['id'])['folder_id'], folders[0]['id'])
        self.assertEqual(app.get_chat(paper['id'])[0]['content'], '迁移颜色前记录')
        self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(), before)

    def test_classification_filter_search_move_and_unfiled(self):
        folder = self.folder()
        alpha = self.paper(folder=folder['id'])['paper']
        beta = self.paper('quartz_beta_same_title.pdf')['paper']
        self.assertEqual(alpha['folder_id'], folder['id'])
        self.assertIsNone(beta['folder_id'])
        def ids(query):
            response = self.request('GET', '/papers?' + query)
            self.assertEqual(response.status_code, 200, response.text)
            return {item['id'] for item in response.json()}
        self.assertEqual(ids('folder_id=all'), {alpha['id'], beta['id']})
        self.assertEqual(ids('folder_id=unfiled'), {beta['id']})
        self.assertEqual(ids('folder_id=' + folder['id']), {alpha['id']})
        self.assertEqual(ids('folder_id=' + folder['id'] + '&q=quartz_beta'), set())
        self.assertEqual(self.request('PATCH', f"/papers/{beta['id']}/folder", {'folder_id': folder['id']}).status_code, 200)
        self.assertEqual(ids('folder_id=' + folder['id']), {alpha['id'], beta['id']})
        self.assertEqual(self.request('PATCH', f"/papers/{alpha['id']}/folder", {'folder_id': None}).status_code, 200)
        self.assertEqual(ids('folder_id=unfiled'), {alpha['id']})

    def test_folder_delete_preserves_documents_body_chat_and_source(self):
        folder = self.folder()
        paper = self.paper(folder=folder['id'])['paper']
        app.add_chat_message(paper['id'], 'user', '已有记录')
        original = app.pdf_path(app.require_paper(paper['id']))
        before = hashlib.sha256(original.read_bytes()).hexdigest()
        with connect() as db:
            body = [tuple(row) for row in db.execute('SELECT id,original_text FROM segments WHERE paper_id=?', (paper['id'],))]
        result = self.request('DELETE', f"/folders/{folder['id']}")
        self.assertEqual(result.status_code, 200, result.text)
        self.assertIsNone(app.get_paper(paper['id'])['folder_id'])
        self.assertEqual(hashlib.sha256(original.read_bytes()).hexdigest(), before)
        self.assertEqual(app.get_chat(paper['id'])[0]['content'], '已有记录')
        with connect() as db:
            self.assertEqual(body, [tuple(row) for row in db.execute('SELECT id,original_text FROM segments WHERE paper_id=?', (paper['id'],))])
        self.assertEqual(self.request('GET', '/folders').json(), [])

    def test_duplicate_import_does_not_reclassify_existing_document(self):
        first = self.folder('分类一')
        second = self.folder('分类二')
        original = self.paper(folder=first['id'])['paper']
        duplicate = self.paper(folder=second['id'])
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(duplicate['paper']['id'], original['id'])
        self.assertEqual(duplicate['paper']['folder_id'], first['id'])

    def test_invalid_names_and_missing_targets_do_not_mutate_library(self):
        for name in ['', '   ']:
            result = self.request('POST', '/folders', {'name': name})
            self.assertEqual(result.status_code, 422, result.text)
        folder = self.folder()
        self.assertIn(self.request('POST', '/folders', {'name': folder['name']}).status_code, [409, 422])
        paper = self.paper()['paper']
        self.assertEqual(self.request('PATCH', f"/papers/{paper['id']}/folder", {'folder_id': 'missing'}).status_code, 404)
        self.assertEqual(self.request('POST', '/papers/import', {'paths': [str(flow.FIXTURES/'quartz_beta_same_title.pdf')], 'folder_id': 'missing'}).status_code, 404)
        self.assertEqual(len(self.request('GET', '/papers').json()), 1)
        self.assertIsNone(app.get_paper(paper['id'])['folder_id'])

    def test_folder_mutations_require_the_app_session(self):
        folder = self.folder()
        paper = self.paper()['paper']
        for method, path, body in [('POST', '/folders', {'name':'未经授权'}), ('PATCH',f"/folders/{folder['id']}",{'name':'未经授权'}),('DELETE',f"/folders/{folder['id']}",None),('PATCH',f"/papers/{paper['id']}/folder",{'folder_id':folder['id']})]:
            self.assertEqual(self.request(method,path,body,token='wrong').status_code,401)
        self.assertEqual(self.request('GET','/folders').json()[0]['name'],folder['name'])

    def test_04_database_migration_preserves_existing_paper_and_chat(self):
        paper = self.paper()['paper']
        app.add_chat_message(paper['id'],'user','迁移前记录')
        with connect() as db:
            db.execute('DROP INDEX IF EXISTS papers_by_folder')
            db.execute('ALTER TABLE papers DROP COLUMN folder_id')
            db.execute('DROP TABLE folders')
            db.execute('ALTER TABLE settings DROP COLUMN models_url')
        initialize()
        self.assertIsNone(app.get_paper(paper['id'])['folder_id'])
        self.assertEqual(app.get_chat(paper['id'])[0]['content'],'迁移前记录')
        self.assertEqual(self.request('GET','/folders').json(),[])
        with patch.object(app.ai,'key_is_configured',return_value=False):
            self.assertEqual(self.request('GET','/settings').json()['models_url'],'')


if __name__ == '__main__':
    unittest.main()
