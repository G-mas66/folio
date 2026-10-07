"""Verify automatic model discovery with real HTTP and isolated credentials."""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from backend import ai
from review import test_translation_flow as flow
from review import test_model_discovery_contract as discovery


class AutomaticModelsReview(unittest.TestCase):
    request = discovery.ModelDiscoveryReview.request

    def setUp(self):
        flow.TranslationFlowReview.setUp(self)
        self.requests = []
        self.status = 200
        self.catalog = {'data': [{'id': 'mimo-v6pro'}, {'id': 'review-B'}]}
        self.password = patch('keyring.get_password', return_value=None)
        self.key_reader = self.password.start()
        self.identity = patch.object(ai, 'credential_service', return_value='review-only-auto-models')
        self.identity.start()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append((self.path, self.headers.get('Authorization')))
                status = 200 if self.path == '/sink' else owner.status
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                if status == 302:
                    self.send_header('Location', '/sink')
                self.end_headers()
                self.wfile.write(json.dumps(owner.catalog).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.identity.stop()
        self.password.stop()
        flow.TranslationFlowReview.tearDown(self)

    def discover(self, url, **extra):
        return self.request('POST', '/settings/models/discover', {'base_url': url, **extra})

    def test_public_catalog_uses_only_url_without_config_model_or_key(self):
        result = self.discover(self.origin + '/v1')
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['models'], ['mimo-v6pro', 'review-B'])
        self.assertEqual(self.requests, [('/v1/models', None)])
        settings = self.request('GET', '/settings').json()
        self.assertEqual(settings['base_url'], '')
        self.assertEqual(settings['model'], '')
        self.assertEqual(settings['model_options'], [])

    def test_base_paths_and_encoded_query_are_preserved(self):
        for base in ['', '/', '/v1', '/v1/', '/gateway/v2/']:
            with self.subTest(base=base):
                result = self.discover(self.origin + base + '?route=test%2Bmodels&x=1&x=2')
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(self.requests[-1], (base.rstrip('/') + '/models?route=test%2Bmodels&x=1&x=2', None))

    def test_chat_and_existing_models_endpoints(self):
        for supplied, expected in [
            ('/v1/chat/completions', '/v1/models'),
            ('/v1/chat/completions/', '/v1/models'),
            ('/v1/models', '/v1/models'),
            ('/v1/models/', '/v1/models/'),
        ]:
            with self.subTest(supplied=supplied):
                result = self.discover(self.origin + supplied + '?routing=one%2Btwo')
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual(self.requests[-1][0], expected + '?routing=one%2Btwo')

    def test_reuses_saved_key_without_requiring_a_default_model(self):
        self.key_reader.return_value = 'review-only-saved-key'
        result = self.discover(self.origin + '/v1')
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.requests[-1][1], 'Bearer review-only-saved-key')

    def test_unsaved_key_does_not_replace_settings_or_add_all_models(self):
        chat_url = self.origin + '/custom/chat/?route=literal%2Bchat'
        with patch.object(ai, 'save_api_key') as save:
            result = self.request('PUT', '/settings', {'base_url': chat_url, 'model': 'original', 'api_key': 'review-only-old'})
            self.assertEqual(result.status_code, 200, result.text)
            save.reset_mock()
            self.key_reader.return_value = 'review-only-old'
            result = self.discover(self.origin + '/v1', api_key='review-only-new')
            self.assertEqual(result.status_code, 200, result.text)
            self.assertFalse(save.called)
        self.assertEqual(self.requests[-1][1], 'Bearer review-only-new')
        settings = self.request('GET', '/settings').json()
        self.assertEqual(settings['base_url'], chat_url)
        self.assertEqual(settings['model'], 'original')
        self.assertEqual(settings['model_options'], [])

    def test_protected_service_requests_key_after_anonymous_get(self):
        self.status = 401
        result = self.discover(self.origin + '/v1')
        self.assertEqual(result.status_code, 502, result.text)
        self.assertEqual(self.requests, [('/v1/models', None)])
        self.assertRegex(result.text, 'Key|授权|权限')

    def test_redirect_does_not_forward_credentials_or_change_host(self):
        self.status = 302
        result = self.discover(self.origin + '/v1', api_key='review-only-redirect-key')
        self.assertEqual(result.status_code, 502, result.text)
        self.assertEqual(self.requests, [('/v1/models', 'Bearer review-only-redirect-key')])
        self.assertNotIn('review-only-redirect-key', result.text)

    def test_bad_urls_never_issue_external_requests(self):
        for supplied in ['', 'file:///tmp/models', self.origin + '/v1#private', 'http://user:review-password@127.0.0.1/v1']:
            with self.subTest(supplied=supplied):
                result = self.discover(supplied)
                self.assertEqual(result.status_code, 422, result.text)
                self.assertNotIn('review-password', result.text)
        self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
