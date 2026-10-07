"""Independent checks for the upstream free service's actual HTTP contract."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx
from backend import free_translation
from review.paths import FIXTURE_ROOT, REVIEW_ROOT


class FreeProviderContractReview(unittest.TestCase):
    def setUp(self):
        self.settings = free_translation._provider_settings
        free_translation._provider_settings = None
        self.environment = patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": ""})
        self.environment.start()
        self.client_type = httpx.AsyncClient

    def tearDown(self):
        free_translation._provider_settings = self.settings
        self.environment.stop()

    def client(self, handler):
        return patch.object(free_translation.httpx, "AsyncClient", side_effect=lambda **kwargs:
            self.client_type(transport=httpx.MockTransport(handler), **kwargs))

    def test_default_handshake_and_complete_text_use_the_project_service_contract(self):
        calls = []
        source = "Complete methods " + "word " * 900 + "APPENDIX_LAST_SENTENCE=811"

        def handle(request):
            calls.append(request)
            self.assertNotIn("authorization", request.headers)
            if request.url.path == "/chatproxy/check":
                self.assertEqual(request.method, "POST")
                return httpx.Response(200, json={"status": "ok"})
            if request.url.path == "/chatproxy/config":
                self.assertEqual(request.method, "GET")
                return httpx.Response(200, json={"status": "ok", "qps": 10, "max_pool_size": 100})
            if request.url.path == "/chatproxy":
                self.assertEqual(request.method, "POST")
                payload = json.loads(request.content)
                self.assertEqual(set(payload), {"text"})
                self.assertTrue(payload["text"].endswith(source), "Long input must not be truncated")
                return httpx.Response(200, json={"content": "完整译文，附录数值811。"})
            return httpx.Response(404, text="Wrong upstream route")

        async def run():
            async with free_translation.FreeTranslationClient() as translator:
                self.assertEqual(await translator.translate(source), "完整译文，附录数值811。")
        with self.client(handle):
            asyncio.run(run())
        self.assertEqual(len(calls), 3)

    def test_loopback_test_url_preserves_its_path_trailing_slash_and_query(self):
        url = "http://127.0.0.1:8123/provider/free-endpoint/?route=paper%2Bnotes"
        with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": url}):
            def handle(request):
                self.assertEqual(str(request.url), url)
                return httpx.Response(200, json={"content": "译文"})
            async def run():
                async with free_translation.FreeTranslationClient() as translator:
                    self.assertEqual(await translator.translate("source"), "译文")
            with self.client(handle):
                asyncio.run(run())

    def test_reasoning_only_or_missing_text_does_not_count_as_translation(self):
        for payload in [{}, {"content": ""}, {"content": "  "}, {"content": 42},
                        {"content": "<think></think>"},
                        {"content": "<think>Unfinished reasoning"},
                        {"content": " \n<think>Reasoning only</think>\n"}]:
            with self.subTest(payload=payload), patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}):
                async def run():
                    async with free_translation.FreeTranslationClient() as translator:
                        with self.assertRaises(free_translation.FreeTranslationError):
                            await translator.translate("The study included 137 participants.")
                with self.client(lambda request: httpx.Response(200, json=payload)):
                    asyncio.run(run())

    def test_immediate_resume_keeps_task_in_the_queue(self):
        from backend import app
        from backend.db import initialize
        root = Path(__file__).resolve().parents[1]

        class RacingClient:
            max_workers = 2
            raced = False

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def translate(self, text, *, cancelled=None):
                if not type(self).raced:
                    type(self).raced = True
                    app.store_status(paper_id, "stopped")
                    await asyncio.sleep(0)
                    app.store_status(paper_id, "queued")
                    return None
                if text == "A Study of Quartz Measurements":
                    return "石英测量研究"
                return "完整测试译文：" + text

        with tempfile.TemporaryDirectory(dir=REVIEW_ROOT) as data:
            with patch.dict(os.environ, {"WORKBENCH_DATA_DIR": data}):
                initialize()
                app.worker_wakeup = asyncio.Event()
                paper_id = app.import_pdf(str(FIXTURE_ROOT / "quartz_alpha.pdf"))["paper"]["id"]
                app.store_status(paper_id, "translating")
                from review.test_translation_flow import fixture_pdf_engine
                with patch.object(app.free_translation, "FreeTranslationClient", RacingClient), patch.object(app, 'run_pdf_engine', fixture_pdf_engine):
                    asyncio.run(app.translate_paper(paper_id))
                    first = app.paper_view(app.require_paper(paper_id))
                    self.assertEqual(first["status"], "queued", "Continue must not be overwritten by a false extraction error")
                    self.assertFalse(first["can_read"])
                    app.store_status(paper_id, "translating")
                    asyncio.run(app.translate_paper(paper_id))
                    self.assertTrue(app.paper_view(app.require_paper(paper_id))["can_read"])


if __name__ == "__main__":
    unittest.main()
