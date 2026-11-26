"""Local HTTPS protocol fixture exercising Boto3 signing and the pinned socket path.

Uses only synthetic objects and a generated test CA; it never reaches a cloud S3
account. Requires the pinned Boto3 runtime from install-s3-runtime.sh.
"""
from __future__ import annotations

import http.server
import ipaddress
from pathlib import Path
import re
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

try:
    import boto3  # noqa: F401
except ImportError:
    boto3 = None

import s3_probe


@unittest.skipIf(boto3 is None, "pinned Boto3 runtime is not installed")
class ProbeTlsFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temp = tempfile.TemporaryDirectory(prefix="codexia-s3-probe-tls-")
        cls.root = Path(cls.temp.name)
        cls.ca = cls.root / "ca.pem"
        cls.ca_key = cls.root / "ca.key"
        cls.key = cls.root / "server.key"
        cls.cert = cls.root / "server.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(cls.ca_key),
                        "-out", str(cls.ca), "-days", "1", "-subj", "/CN=Codexia probe fixture CA"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        csr = cls.root / "server.csr"
        subprocess.run(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-keyout", str(cls.key),
                        "-out", str(csr), "-subj", "/CN=objects.fixture.test"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ext = cls.root / "server.ext"
        ext.write_text("subjectAltName=DNS:objects.fixture.test\nextendedKeyUsage=serverAuth\n", encoding="ascii")
        subprocess.run(["openssl", "x509", "-req", "-in", str(csr), "-CA", str(cls.ca), "-CAkey", str(cls.ca_key),
                        "-CAcreateserial", "-out", str(cls.cert), "-days", "1", "-extfile", str(ext)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        private_networks = tuple(map(ipaddress.ip_network, ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")))
        candidates = [address[4][0] for address in socket.getaddrinfo(
            socket.gethostname(), None, type=socket.SOCK_STREAM) if address[0] == socket.AF_INET]
        if not any(any(ipaddress.ip_address(value) in net for net in private_networks) for value in candidates):
            try:
                rows = subprocess.run(["ip", "-o", "-4", "address", "show", "up"], check=True,
                                      capture_output=True, text=True).stdout.splitlines()
                candidates.extend(re.findall(r"\binet (\d+(?:\.\d+){3})/", "\n".join(rows)))
            except (OSError, subprocess.CalledProcessError):
                pass
        cls.private_ip = next((value for value in candidates if any(
            ipaddress.ip_address(value) in net for net in private_networks)), None)
        if cls.private_ip is None:
            raise RuntimeError("TLS fixture requires an available RFC1918 IPv4 interface")
        cls.objects: dict[str, bytes] = {}
        cls.authenticated: list[str] = []
        cls.wire: list[tuple[str, str, int, str, str]] = []
        cls.redirect = False

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_: object) -> None:
                pass

            def _reply(self, code: int, body: bytes = b"") -> None:
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def do_PUT(self) -> None:
                cls.authenticated.append(self.headers.get("Authorization", ""))
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    chunks = []
                    while True:
                        header = self.rfile.readline().split(b";", 1)[0].strip()
                        size = int(header, 16)
                        if not size:
                            while self.rfile.readline().strip():
                                pass
                            break
                        chunks.append(self.rfile.read(size))
                        self.rfile.read(2)
                    body = b"".join(chunks)
                else:
                    body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                cls.wire.append(("PUT", self.path, len(body), self.headers.get("Content-Length", ""), self.headers.get("Transfer-Encoding", "")))
                cls.objects[self.path] = body
                self._reply(200)

            def do_GET(self) -> None:
                cls.authenticated.append(self.headers.get("Authorization", ""))
                cls.wire.append(("GET", self.path, -1, "", ""))
                if cls.redirect:
                    self.send_response(302)
                    self.send_header("Location", "https://127.0.0.1/metadata")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = cls.objects.get(self.path)
                if body is None:
                    self._reply(404, b"<Error><Code>NoSuchKey</Code></Error>")
                else:
                    self._reply(200, body)

            def do_DELETE(self) -> None:
                cls.authenticated.append(self.headers.get("Authorization", ""))
                cls.objects.pop(self.path, None)
                self._reply(204)

        cls.server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), Handler)
        cls.port = cls.server.server_address[1]
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cls.cert), str(cls.key))
        cls.server.socket = context.wrap_socket(cls.server.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.temp.cleanup()

    def setUp(self) -> None:
        self.objects.clear()
        self.authenticated.clear()
        self.wire.clear()
        type(self).redirect = False
        self.draft = {"provider": "s3-compatible", "region": "us-east-1", "bucket": "codexia-fixture",
                      "prefix": "codexia/backups", "endpoint": f"https://objects.fixture.test:{self.port}",
                      "addressingStyle": "path",
                      "credential": {"accessKeyId": "fixture-access", "secretAccessKey": "fixture-secret"}}
        self.policy = {"destinations": [{"provider": "s3-compatible", "bucket": "codexia-fixture",
                       "prefix": "codexia/backups", "origin": f"https://objects.fixture.test:{self.port}",
                       "caBundle": str(self.ca), "allowedPrivateAddresses": [self.private_ip],
                       "allowProbeCleanup": True}]}
        original = socket.getaddrinfo

        def fixture_dns(host: str, port: int, *args: object, **kwargs: object):
            if host == "objects.fixture.test":
                return original(self.private_ip, port, *args, **kwargs)
            return original(host, port, *args, **kwargs)

        self.dns_patch = patch("s3_transfer.socket.getaddrinfo", side_effect=fixture_dns)
        self.dns_patch.start()
        self.addCleanup(self.dns_patch.stop)

    def test_guarded_boto3_tls_signed_put_get_and_versionless_cleanup(self) -> None:
        result = s3_probe.probe_destination(self.draft, self.policy)
        self.assertEqual(result["status"], "PASSED")
        self.assertEqual(result["cleanupStatus"], "removed")
        self.assertFalse(self.objects)
        self.assertEqual(len(self.authenticated), 3)
        self.assertTrue(all(value.startswith("AWS4-HMAC-SHA256 ") for value in self.authenticated))

    def test_tls_read_redirect_is_classified_and_never_followed(self) -> None:
        type(self).redirect = True
        result = s3_probe.probe_destination(self.draft, self.policy)
        self.assertEqual((result["status"], result["reasonCode"]), ("FAILED", "redirect_rejected"))
        self.assertFalse(any("/metadata" in key for key in self.objects))


if __name__ == "__main__":
    unittest.main()
