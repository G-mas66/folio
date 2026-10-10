"""Independent checks for the upstream free service's actual HTTP contract."""
import asyncio
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest.mock import patch

import httpx
from backend import free_translation
from review.paths import FIXTURE_ROOT, REVIEW_ROOT


class FreeProviderContractReview(unittest.TestCase):
    def setUp(self):
        self.settings = free_translation._provider_settings
        self.next_request_at = free_translation._shared_next_request_at
        self.cooldown_until = free_translation._shared_cooldown_until
        free_translation._provider_settings = None
        free_translation._shared_next_request_at = 0.0
        free_translation._shared_cooldown_until = 0.0
        self.environment = patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": ""})
        self.environment.start()
        self.client_type = httpx.AsyncClient

    def tearDown(self):
        free_translation._provider_settings = self.settings
        free_translation._shared_next_request_at = self.next_request_at
        free_translation._shared_cooldown_until = self.cooldown_until
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

    def test_rate_limit_retries_and_honors_retry_after(self):
        requests = []

        def handle(request):
            requests.append(time.monotonic())
            if len(requests) == 1:
                return httpx.Response(429, headers={"Retry-After": "0.25"})
            return httpx.Response(200, json={"content": "恢复后的译文"})

        async def run():
            async with free_translation.FreeTranslationClient() as translator:
                return await translator.translate("The service briefly rate limited this request.")

        with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}), self.client(handle):
            translation = asyncio.run(run())
        self.assertEqual(translation, "恢复后的译文")
        self.assertEqual(len(requests), 2)
        self.assertGreaterEqual(requests[1] - requests[0], 0.22)

    def test_http_date_retry_after_is_parsed(self):
        value = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=10), usegmt=True)
        delay = free_translation._retry_after_seconds(value)
        self.assertIsNotNone(delay)
        self.assertGreater(delay, 8)
        self.assertLessEqual(delay, 10)

    def test_title_and_selection_calls_recover_from_rate_limit_without_retry_after(self):
        title_source = "CytoBERT: A Foundation Model for Cytometry Data"
        selection_source = "We evaluated the model on independent cytometry datasets."
        attempts = {title_source: 0, selection_source: 0}

        def handle(request):
            text = json.loads(request.content)["text"]
            source = next(source for source in attempts if text.endswith(source))
            attempts[source] += 1
            if attempts[source] == 1:
                return httpx.Response(429)
            return httpx.Response(200, json={"content": "中文译文"})

        async def run_one(source, *, cancelled=None):
            async with free_translation.FreeTranslationClient() as translator:
                return await translator.translate(source, cancelled=cancelled)

        async def run():
            title = await run_one(title_source, cancelled=lambda: False)
            selection = await run_one(selection_source)
            return title, selection

        with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}), self.client(handle):
            self.assertEqual(asyncio.run(run()), ("中文译文", "中文译文"))
        self.assertEqual(attempts, {title_source: 2, selection_source: 2})

    def test_persistent_rate_limit_stops_after_two_retries(self):
        requests = []

        def handle(_request):
            requests.append(None)
            return httpx.Response(429, headers={"Retry-After": "0"})

        async def run():
            async with free_translation.FreeTranslationClient() as translator:
                with self.assertRaises(free_translation.FreeTranslationError) as raised:
                    await translator.translate("The service keeps rate limiting this request.")
            return raised.exception

        with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}), self.client(handle):
            error = asyncio.run(run())
        self.assertEqual(len(requests), free_translation.MAX_RATE_LIMIT_RETRIES + 1)
        self.assertEqual(error.category, "rate_limit")
        self.assertIn("本段尚未完成", str(error))

    def test_long_retry_after_returns_rate_limit_without_retrying_early(self):
        requests = []

        def handle(_request):
            requests.append(None)
            return httpx.Response(429, headers={"Retry-After": "31"})

        async def run():
            async with free_translation.FreeTranslationClient() as translator:
                with self.assertRaises(free_translation.FreeTranslationError) as raised:
                    await translator.translate("Wait for the provider's retry window.")
            return raised.exception

        with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}), self.client(handle):
            error = asyncio.run(run())
        self.assertEqual(requests, [None])
        self.assertEqual(error.category, "rate_limit")

    def test_other_failures_are_not_retried(self):
        for response, category in (
            (httpx.Response(500), "service_error"),
            (httpx.Response(200, json={}), "invalid_response"),
        ):
            with self.subTest(category=category):
                requests = []

                def handle(_request):
                    requests.append(None)
                    return response

                async def run():
                    async with free_translation.FreeTranslationClient() as translator:
                        with self.assertRaises(free_translation.FreeTranslationError) as raised:
                            await translator.translate("Do not retry a non-rate-limit failure.")
                    return raised.exception

                with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}), self.client(handle):
                    error = asyncio.run(run())
                self.assertEqual(requests, [None])
                self.assertEqual(error.category, category)

    def test_cancellation_during_rate_limit_wait_skips_the_next_attempt(self):
        cancelled = threading.Event()
        timer = None
        requests = []

        def handle(_request):
            nonlocal timer
            requests.append(None)
            timer = threading.Timer(0.05, cancelled.set)
            timer.start()
            return httpx.Response(429, headers={"Retry-After": "0.5"})

        async def run():
            async with free_translation.FreeTranslationClient() as translator:
                return await translator.translate("Cancel while waiting to retry.", cancelled=cancelled.is_set)

        with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}), self.client(handle):
            started_at = time.monotonic()
            translation = asyncio.run(run())
            elapsed = time.monotonic() - started_at
        assert timer is not None
        timer.join()
        self.assertIsNone(translation)
        self.assertEqual(len(requests), 1)
        self.assertLess(elapsed, 0.4)

    def test_translation_rate_limit_is_shared_between_client_instances(self):
        requests = []

        def handle(_request):
            requests.append(time.monotonic())
            return httpx.Response(200, json={"content": "译文"})

        async def run_one():
            async with free_translation.FreeTranslationClient() as translator:
                return await translator.translate("source")

        async def run():
            return await asyncio.gather(*(run_one() for _ in range(3)))

        with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}), self.client(handle):
            self.assertEqual(asyncio.run(run()), ["译文"] * 3)
        self.assertEqual(len(requests), 3)
        self.assertGreaterEqual(requests[1] - requests[0], 0.07)
        self.assertGreaterEqual(requests[2] - requests[1], 0.07)

    def test_shared_cooldown_reschedules_clients_already_waiting_for_qps(self):
        request_times = []
        started = 0

        async def run_one():
            nonlocal started
            async with free_translation.FreeTranslationClient() as translator:
                started += 1
                await translator._wait_for_qps()
                request_times.append(time.monotonic())

        async def run():
            free_translation._shared_next_request_at = time.monotonic() + 0.1
            tasks = [asyncio.create_task(run_one()) for _ in range(3)]
            while started < 3:
                await asyncio.sleep(0)
            cooldown_started = time.monotonic()
            free_translation._defer_shared_requests(0.5)
            await asyncio.gather(*tasks)
            return cooldown_started

        with patch.dict(os.environ, {"WORKBENCH_FREE_API_URL": "http://localhost:8123/free"}), self.client(
            lambda _request: httpx.Response(200, json={"content": "unused"})
        ):
            cooldown_started = asyncio.run(run())
        self.assertEqual(len(request_times), 3)
        self.assertGreaterEqual(request_times[1], cooldown_started + 0.45)
        self.assertGreaterEqual(request_times[2] - request_times[1], 0.07)

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
