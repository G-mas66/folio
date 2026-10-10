from __future__ import annotations

import asyncio
import ipaddress
import os
import re
import threading
import time
from collections.abc import Callable
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

import httpx

API_URL = "https://api1.pdf2zh-next.com/chatproxy"
CHECK_URL = f"{API_URL}/check"
CONFIG_URL = f"{API_URL}/config"
DEFAULT_QPS = 10
DEFAULT_WORKERS = 4
MAX_WORKERS = 4
MAX_RATE_LIMIT_RETRIES = 2
MAX_RATE_LIMIT_RETRY_DELAY = 30
RATE_LIMIT_WAIT_POLL_INTERVAL = 0.1

_provider_settings: tuple[int, int] | None = None
_shared_rate_lock = threading.Lock()
_shared_next_request_at = 0.0
_shared_cooldown_until = 0.0


def _retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
        if retry_at.tzinfo is None:
            retry_at = retry_at.replace(tzinfo=timezone.utc)
        return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())


def _defer_shared_requests(delay: float) -> None:
    global _shared_cooldown_until
    with _shared_rate_lock:
        _shared_cooldown_until = max(_shared_cooldown_until, time.monotonic() + delay)


class FreeTranslationError(Exception):
    def __init__(self, category: str, message: str):
        super().__init__(message)
        self.category = category
        self.message = message

    def __str__(self) -> str:
        return self.message


def _translation_url() -> tuple[str, bool]:
    override = os.environ.get("WORKBENCH_FREE_API_URL", "").strip()
    if not override:
        return API_URL, False
    parsed = urlsplit(override)
    host = (parsed.hostname or "").casefold()
    loopback = host == "localhost"
    try:
        loopback = loopback or ipaddress.ip_address(host).is_loopback
    except ValueError:
        pass
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not loopback:
        raise FreeTranslationError("configuration", "免费翻译测试地址只允许使用环回主机。")
    return override, True


class FreeTranslationClient:
    def __init__(self):
        self.url, self.is_test_override = _translation_url()
        self.qps = DEFAULT_QPS
        self.max_workers = DEFAULT_WORKERS
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=15))
        self._semaphore: asyncio.Semaphore | None = None

    async def __aenter__(self):
        try:
            if not self.is_test_override:
                await self._load_service_settings()
            self._semaphore = asyncio.Semaphore(self.max_workers)
            return self
        except BaseException:
            await self._client.aclose()
            raise

    async def __aexit__(self, exc_type, exc_value, traceback):
        await self._client.aclose()

    async def _load_service_settings(self) -> None:
        global _provider_settings
        if _provider_settings is not None:
            self.qps, self.max_workers = _provider_settings
            return
        try:
            response = await self._client.post(CHECK_URL, timeout=10)
            payload = response.json()
            if response.status_code != 200 or not isinstance(payload, dict) or payload.get("status") != "ok":
                raise FreeTranslationError("service_unavailable", "免费翻译服务暂时不可用。")
        except FreeTranslationError:
            raise
        except (httpx.HTTPError, ValueError):
            raise FreeTranslationError("service_unavailable", "无法连接免费翻译服务，请检查网络后重试。") from None

        try:
            response = await self._client.get(CONFIG_URL, timeout=10)
            response.raise_for_status()
            payload = response.json()
            qps = payload.get("qps") if isinstance(payload, dict) else None
            workers = payload.get("max_pool_size") if isinstance(payload, dict) else None
            if isinstance(qps, int) and qps > 0 and isinstance(workers, int) and workers > 0:
                self.qps = qps
                self.max_workers = min(workers, MAX_WORKERS)
        except (httpx.HTTPError, ValueError):
            pass
        _provider_settings = (self.qps, self.max_workers)

    async def _wait_for_qps(self, cancelled: Callable[[], bool] | None = None) -> bool:
        global _shared_next_request_at
        while True:
            if cancelled and await asyncio.to_thread(cancelled):
                return False
            with _shared_rate_lock:
                now = time.monotonic()
                request_at = max(now, _shared_next_request_at, _shared_cooldown_until)
                delay = request_at - now
                if delay <= 0:
                    _shared_next_request_at = now + 1 / self.qps
                    return True
            await asyncio.sleep(min(delay, RATE_LIMIT_WAIT_POLL_INTERVAL))

    async def translate(self, text: str, *, cancelled: Callable[[], bool] | None = None) -> str | None:
        if not isinstance(text, str) or not text.strip():
            raise FreeTranslationError("empty_source", "没有可翻译的文本。")
        semaphore = self._semaphore or asyncio.Semaphore(self.max_workers)
        async with semaphore:
            prompt = (
                "You are a professional,authentic machine translation engine.\n\n"
                ";; Treat next line as plain text input and translate it into zh, output translation ONLY. "
                "If translation is unnecessary (e.g. proper nouns, codes, {{1}}, etc. ), return the original text. "
                "NO explanations. NO notes. Input:\n\n"
                f"{text}"
            )
            for attempt in range(MAX_RATE_LIMIT_RETRIES + 1):
                if not await self._wait_for_qps(cancelled):
                    return None
                if cancelled and await asyncio.to_thread(cancelled):
                    return None
                try:
                    response = await self._client.post(self.url, json={"text": prompt})
                except httpx.TimeoutException:
                    raise FreeTranslationError("timeout", "免费翻译服务连接超时，本段尚未完成。") from None
                except httpx.RequestError:
                    raise FreeTranslationError("network", "无法连接免费翻译服务，本段尚未完成。") from None
                if response.status_code != 429:
                    break
                if cancelled and await asyncio.to_thread(cancelled):
                    return None
                retry_after = _retry_after_seconds(response.headers.get("Retry-After"))
                if retry_after is None:
                    retry_delay = min(4 * 2 ** attempt, MAX_RATE_LIMIT_RETRY_DELAY)
                elif retry_after > MAX_RATE_LIMIT_RETRY_DELAY:
                    _defer_shared_requests(MAX_RATE_LIMIT_RETRY_DELAY)
                    raise FreeTranslationError("rate_limit", "免费翻译服务暂时限流，本段尚未完成，可稍后重试。")
                else:
                    retry_delay = retry_after
                _defer_shared_requests(retry_delay)
                if attempt == MAX_RATE_LIMIT_RETRIES:
                    raise FreeTranslationError("rate_limit", "免费翻译服务暂时限流，本段尚未完成，可稍后重试。")
            if response.status_code >= 400:
                raise FreeTranslationError("service_error", f"免费翻译服务返回 HTTP {response.status_code}，本段尚未完成。")
            try:
                payload = response.json()
            except ValueError:
                raise FreeTranslationError("invalid_response", "免费翻译服务返回了无效数据，本段尚未完成。") from None
            content = payload.get("content") if isinstance(payload, dict) else None
            if not isinstance(content, str):
                raise FreeTranslationError("invalid_response", "免费翻译服务未返回译文，本段尚未完成。")
            content = re.sub(r"^<think>.*?</think>", "", content.strip(), count=1, flags=re.DOTALL).strip()
            if content.startswith("<think>"):
                raise FreeTranslationError("incomplete_response", "免费翻译服务响应未完整结束，本段尚未完成。")
            if not content:
                raise FreeTranslationError("empty_response", "免费翻译服务返回空译文，本段尚未完成。")
            return content
