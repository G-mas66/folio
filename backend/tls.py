"""Verified HTTPS trust shared by urllib and packaged network diagnostics."""
from __future__ import annotations

import os
import socket
import ssl
import urllib.error

import certifi


def verified_context() -> ssl.SSLContext:
    # Honour explicit administrator/user trust configuration, as HTTPX does.
    cafile = os.environ.get("SSL_CERT_FILE") or None
    capath = os.environ.get("SSL_CERT_DIR") or None
    if cafile or capath:
        return ssl.create_default_context(cafile=cafile, capath=capath)
    # Frozen macOS Python may have no usable OpenSSL system CA directory.
    context = ssl.create_default_context(cafile=certifi.where())
    context.load_default_certs()
    return context


def network_failure(error: BaseException) -> tuple[str, str]:
    reason = error.reason if isinstance(error, urllib.error.URLError) else error
    seen: set[int] = set()
    while id(reason) not in seen:
        seen.add(id(reason))
        if isinstance(reason, ssl.SSLError):
            break
        nested = getattr(reason, "__cause__", None) or getattr(reason, "__context__", None)
        if nested is None:
            break
        reason = nested
    if isinstance(reason, ssl.SSLError):
        return "tls", "HTTPS 证书验证或 TLS 连接失败，请检查系统时间、代理证书及 SSL_CERT_FILE/SSL_CERT_DIR 配置。"
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return "timeout", "连接服务超时，请检查网络或稍后重试。"
    if isinstance(reason, (FileNotFoundError, NotADirectoryError)):
        return "tls", "无法加载 HTTPS 证书配置，请检查 SSL_CERT_FILE/SSL_CERT_DIR 指向的路径。"
    return "network", "无法连接服务，请检查地址和网络。"
