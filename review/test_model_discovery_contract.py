"""Exercise model discovery against an independent HTTP server without private keys."""
import asyncio
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import httpx
from backend import ai, app
from review import test_translation_flow as flow


class ModelDiscoveryReview(unittest.TestCase):
    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.requests = []
        self.status = 200
        self.payload = {'data': [{'id':'mimo-v6pro'}, {'id':'review-B'}, {'id':'mimo-v6pro'}]}
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append((self.command,self.path,self.headers.get('Authorization')))
                self.send_response(owner.status)
                self.send_header('Content-Type','application/json')
                self.end_headers()
                self.wfile.write(json.dumps(owner.payload).encode('utf-8'))
            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.chat_url = f'http://127.0.0.1:{self.server.server_port}/literal/chat/?route=unchanged%2Brequest'
        self.models_url = f'http://127.0.0.1:{self.server.server_port}/literal/models/?route=custom%2Blist'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        flow.TranslationFlowReview.tearDown(self)

    def request(self, method, path, body=None, authenticated=True):
        import os
        async def call():
            with patch.dict(os.environ, {'WORKBENCH_SESSION_TOKEN':'models-review-session'}):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app.app),base_url='http://test',headers={'Authorization':'Bearer '+('models-review-session' if authenticated else 'wrong')}) as client:
                    return await client.request(method,path,json=body)
        return asyncio.run(call())

    def discover(self, authenticated=True):
        return self.request('POST','/settings/models/discover',{'models_url':self.models_url,'api_key':'review-only-discovery-key'},authenticated)

    def test_literal_get_with_key_and_deduplicated_model_ids(self):
        response = self.discover()
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['models'],['mimo-v6pro','review-B'])
        self.assertEqual(self.requests,[('GET','/literal/models/?route=custom%2Blist','Bearer review-only-discovery-key')])

    def test_discovery_does_not_change_chat_url_model_or_saved_key(self):
        with patch.object(ai,'save_api_key') as key:
            saved = self.request('PUT','/settings',{'base_url':self.chat_url,'model':'original-model','api_key':'review-only-existing-key','models_url':self.models_url})
            self.assertEqual(saved.status_code,200,saved.text)
            key.reset_mock()
            response = self.discover()
            self.assertEqual(response.status_code,200,response.text)
            self.assertFalse(key.called)
        with patch.object(ai,'key_is_configured',return_value=False):
            settings = self.request('GET','/settings').json()
        self.assertEqual(settings['base_url'],self.chat_url)
        self.assertEqual(settings['model'],'original-model')
        self.assertEqual(settings['model_options'],[],'Discovery alone must not add every returned model')
        self.assertEqual(settings['models_url'],self.models_url)

    def test_selected_models_persist_without_new_credentials(self):
        models = self.discover().json()['models']
        with patch.object(ai,'save_api_key') as key:
            response = self.request('PUT','/settings/models',{'models':[models[0]]})
            self.assertEqual(response.status_code,200,response.text)
            self.assertFalse(key.called)
        with patch.object(ai,'key_is_configured',return_value=False):
            self.assertEqual(self.request('GET','/settings').json()['model_options'],['mimo-v6pro'])

    def test_unsupported_endpoint_keeps_manual_add_available(self):
        for status in [404,405]:
            self.status = status
            response = self.discover()
            self.assertEqual(response.status_code,502,response.text)
            self.assertRegex(response.text,'模型|列表')
        self.assertEqual(self.request('PUT','/settings/models',{'models':['mimo-v6pro']}).status_code,200)

    def test_authentication_errors_do_not_return_keys(self):
        for status in [401,403]:
            self.status = status
            response = self.discover()
            self.assertEqual(response.status_code,502,response.text)
            self.assertNotIn('review-only-discovery-key',response.text)
            self.assertRegex(response.text,'Key|权限|认证')

    def test_malformed_list_is_not_success(self):
        for payload in [{}, {'data':'not-a-list'}, {'data':[{'id':17}]}]:
            self.payload = payload
            response = self.discover()
            self.assertEqual(response.status_code,502,response.text)

    def test_empty_and_large_valid_catalogs_are_returned_without_adding_them(self):
        self.payload = {'data':[]}
        response = self.discover()
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['models'],[])
        self.payload = {'data':[{'id':f'catalog-model-{index}'} for index in range(601)]}
        response = self.discover()
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(len(response.json()['models']),601)
        with patch.object(ai,'key_is_configured',return_value=False):
            self.assertEqual(self.request('GET','/settings').json()['model_options'],[])

    def test_bad_session_never_calls_external_server(self):
        response = self.discover(authenticated=False)
        self.assertEqual(response.status_code,401)
        self.assertEqual(self.requests,[])


if __name__ == '__main__':
    unittest.main()
