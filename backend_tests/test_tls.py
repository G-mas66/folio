"""TLS trust and diagnostics regressions; certificates and servers are temporary."""
import contextlib
import datetime
import os
from pathlib import Path
import ssl
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

from backend import tls

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
except ImportError:
    x509 = None


@contextlib.contextmanager
def local_https_catalog():
    """Serve a localhost-only certificate signed by a disposable, private CA."""
    if x509 is None:
        raise unittest.SkipTest("cryptography is not installed; no dependencies added")
    now = datetime.datetime.now(datetime.timezone.utc)

    def certificate(name, key, issuer=None, issuer_key=None, ca=False):
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
        builder = (x509.CertificateBuilder().subject_name(subject)
                   .issuer_name(issuer.subject if issuer else subject)
                   .public_key(key.public_key()).serial_number(x509.random_serial_number())
                   .not_valid_before(now - datetime.timedelta(minutes=5))
                   .not_valid_after(now + datetime.timedelta(days=1))
                   .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True))
        if not ca:
            builder = builder.add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
        return builder.sign(issuer_key or key, hashes.SHA256())

    with tempfile.TemporaryDirectory(prefix="workbench-tls-test-") as folder:
        root = Path(folder)
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca = certificate("Temporary TLS test CA", ca_key, ca=True)
        other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        other = certificate("Unrelated TLS test CA", other_key, ca=True)
        server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        server_cert = certificate("localhost", server_key, ca, ca_key)
        for name, cert in [("ca.pem", ca), ("other.pem", other), ("server.pem", server_cert)]:
            (root / name).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        (root / "server-key.pem").write_bytes(server_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get("Authorization")))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"data":[{"id":"temporary-https-model"}]}')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        try:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(root / "server.pem", root / "server-key.pem")
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                yield root, server.server_port, requests
            finally:
                server.shutdown()
                thread.join(timeout=5)
        finally:
            server.server_close()


class VerifiedContextTests(unittest.TestCase):
    def clean_environment(self, **extra):
        environment = dict(os.environ)
        environment.pop("SSL_CERT_FILE", None)
        environment.pop("SSL_CERT_DIR", None)
        environment.update(extra)
        return patch.dict(os.environ, environment, clear=True)

    def test_default_context_verifies_hostname_and_contains_ca_certificates(self):
        with self.clean_environment():
            context = tls.verified_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertGreater(context.cert_store_stats()["x509_ca"], 0)

    def test_default_trust_combines_certifi_and_system_roots(self):
        context = Mock(spec=ssl.SSLContext)
        with self.clean_environment(), patch.object(tls.certifi, "where", return_value="bundled-ca.pem"), patch.object(tls.ssl, "create_default_context", return_value=context) as create:
            self.assertIs(tls.verified_context(), context)
        create.assert_called_once_with(cafile="bundled-ca.pem")
        context.load_default_certs.assert_called_once_with()

    def test_explicit_file_and_directory_take_precedence_over_default_roots(self):
        for values in [{"SSL_CERT_FILE": "explicit-ca.pem"}, {"SSL_CERT_DIR": "explicit-ca-dir"},
                       {"SSL_CERT_FILE": "explicit-ca.pem", "SSL_CERT_DIR": "explicit-ca-dir"}]:
            with self.subTest(values=values):
                context = Mock(spec=ssl.SSLContext)
                with self.clean_environment(**values), patch.object(tls.certifi, "where") as bundled, patch.object(tls.ssl, "create_default_context", return_value=context) as create:
                    self.assertIs(tls.verified_context(), context)
                create.assert_called_once_with(cafile=values.get("SSL_CERT_FILE"), capath=values.get("SSL_CERT_DIR"))
                bundled.assert_not_called()
                context.load_default_certs.assert_not_called()

    def test_nonexistent_explicit_ca_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.clean_environment(SSL_CERT_FILE=str(Path(folder) / "missing.pem")):
                with self.assertRaises(OSError):
                    tls.verified_context()

    def test_real_https_trusted_ca_succeeds_untrusted_and_wrong_host_fail(self):
        with local_https_catalog() as (root, port, requests):
            for ca, host, succeeds in [("ca.pem", "localhost", True), ("other.pem", "localhost", False), ("ca.pem", "127.0.0.1", False)]:
                with self.subTest(ca=ca, host=host), self.clean_environment(SSL_CERT_FILE=str(root / ca)):
                    context = tls.verified_context()
                    self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
                    self.assertTrue(context.check_hostname)
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
                    url = f"https://{host}:{port}/models"
                    if succeeds:
                        with opener.open(url, timeout=3) as response:
                            self.assertEqual(response.status, 200)
                    else:
                        with self.assertRaises(urllib.error.URLError) as caught:
                            opener.open(url, timeout=3)
                        self.assertIsInstance(caught.exception.reason, ssl.SSLCertVerificationError)
                        self.assertEqual(tls.network_failure(caught.exception)[0], "tls")
            self.assertEqual(requests, [("/models", None)])


class NetworkFailureTests(unittest.TestCase):
    def test_categories_hide_raw_error_details_and_credentials(self):
        secret = "temporary-secret-do-not-disclose"
        for reason, expected in [(ssl.SSLCertVerificationError(1, secret), "tls"),
                                 (ssl.SSLError(1, secret), "tls"), (TimeoutError(secret), "timeout"),
                                 (ConnectionRefusedError(secret), "network"),
                                 (FileNotFoundError(secret), "tls"), (NotADirectoryError(secret), "tls")]:
            for error in [reason, urllib.error.URLError(reason)]:
                with self.subTest(error=type(error).__name__, reason=type(reason).__name__):
                    category, message = tls.network_failure(error)
                    self.assertEqual(category, expected)
                    self.assertNotIn(secret, message)
                    self.assertTrue(message)

    def test_string_url_error_reason_is_network_and_does_not_crash_or_leak(self):
        category, message = tls.network_failure(urllib.error.URLError("temporary-secret connection refused"))
        self.assertEqual(category, "network")
        self.assertNotIn("temporary-secret", message)

    def test_wrapped_causes_and_cycles_are_handled(self):
        for cause, expected in [(ssl.SSLError(1, "secret"), "tls"), (TimeoutError("secret"), "timeout")]:
            outer = OSError("outer")
            outer.__cause__ = cause
            self.assertEqual(tls.network_failure(urllib.error.URLError(outer))[0], expected)
        first, second = OSError("first"), OSError("second")
        first.__cause__, second.__cause__ = second, first
        self.assertEqual(tls.network_failure(first)[0], "network")


if __name__ == "__main__":
    unittest.main()
