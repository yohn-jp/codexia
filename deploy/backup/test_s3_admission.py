"""Checks for canonical backup bytes and direct S3 endpoint access."""

from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.util import find_spec
import json
import os
from pathlib import Path
import ssl
import socket
import subprocess
import sys
import tempfile
from threading import Thread
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from deploy.backup.test_s3_transfer import FakeS3Client, profile, s3_transfer, sha256


class ChecksumAdmissionTests(unittest.TestCase):
    def test_noncanonical_checksum_manifests_are_rejected_before_s3_access(self):
        with tempfile.TemporaryDirectory(prefix="codexia-v2-checksum-") as temporary:
            artifact = Path(temporary)
            checksum_lines = []
            for name in s3_transfer.ARTIFACT_FILES:
                data = f"synthetic ciphertext for {name}".encode("ascii")
                (artifact / name).write_bytes(data)
                checksum_lines.append(f"{sha256(data)}  {name}\n".encode("ascii"))
            canonical = b"".join(checksum_lines)
            manifest = artifact / "SHA256SUMS"
            manifest.write_bytes(canonical)
            self.assertEqual(s3_transfer.validate_artifact(artifact)["sha256sumsSha256"], sha256(canonical))

            for variant, content in (
                ("different order", b"".join(reversed(checksum_lines))),
                ("CRLF", canonical.replace(b"\n", b"\r\n")),
                ("missing final newline", canonical[:-1]),
            ):
                with self.subTest(variant=variant):
                    manifest.write_bytes(content)
                    client = FakeS3Client()
                    transfer = s3_transfer.S3BackupTransfer(profile(), client=client)
                    receipt = artifact / f"receipt-{variant}.json"
                    with self.assertRaisesRegex(s3_transfer.TransferError, "checksum"):
                        transfer.upload_artifact(
                            artifact, backup_id="checksum-test", source_identity="a" * 40,
                            receipt_path=receipt,
                        )
                    self.assertEqual(client.events, [])
                    self.assertFalse(receipt.exists())


class EndpointHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.server.received.append(self.path)
        self.send_response(200)
        self.end_headers()


class ProxyTrapHandler(EndpointHandler):
    def do_CONNECT(self):
        self.server.received.append(self.path)
        self.send_error(502)


@contextmanager
def serve_loopback(handler, *, tls_context=None):
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        server.received = []
        if tls_context:
            server.socket = tls_context.wrap_socket(server.socket, server_side=True)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"127.0.0.1:{server.server_port}", server.received
        finally:
            server.shutdown()
            thread.join()


class ProxyAdmissionTests(unittest.TestCase):
    def test_operator_private_addresses_cannot_approve_local_or_metadata_endpoints(self):
        with tempfile.TemporaryDirectory(prefix="codexia-s3-private-") as directory:
            path = Path(directory) / "profile.json"
            for address in ("127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "224.0.0.1"):
                with self.subTest(address=address):
                    path.write_text(json.dumps(profile(allowedPrivateAddresses=[address])))
                    path.chmod(0o600)
                    with self.assertRaises(s3_transfer.TransferError):
                        s3_transfer.load_profile(path)
            path.write_text(json.dumps(profile(allowedPrivateAddresses=["10.20.30.40"])))
            selected = s3_transfer.load_profile(path)
            guard = s3_transfer.EndpointGuard(selected, selected["endpointUrl"], allowed_private_addresses=selected["allowedPrivateAddresses"])
            for address, accepted in (("10.20.30.40", True), ("10.20.30.41", False), ("8.8.8.8", False)):
                with self.subTest(resolved=address), patch.object(socket, "getaddrinfo", return_value=[(0, 0, 0, "", (address, 443))]):
                    if accepted:
                        self.assertEqual(guard._resolve_public_addresses("objects.example.test", 443), (address,))
                    else:
                        with self.assertRaises(s3_transfer.TransferError):
                            guard._resolve_public_addresses("objects.example.test", 443)

    def test_s3_sdk_config_explicitly_disables_proxies(self):
        sdk_config = Mock()
        sdk_client = SimpleNamespace(meta=SimpleNamespace(endpoint_url=profile()["endpointUrl"], events=Mock()))
        fake_session = Mock(return_value=SimpleNamespace(client=Mock(return_value=sdk_client)))
        with patch.object(s3_transfer, "_install_pinned_https_transport") as install_transport, patch.dict(sys.modules, {
            "boto3": SimpleNamespace(session=SimpleNamespace(Session=fake_session)),
            "botocore.config": SimpleNamespace(Config=sdk_config),
        }):
            s3_transfer.S3BackupTransfer(profile())

        self.assertEqual(sdk_config.call_args.kwargs.get("proxies"), {})
        install_transport.assert_called_once()

    @unittest.skipUnless(find_spec("boto3"), "install the pinned S3 runtime for the real SDK test")
    def test_pinned_sdk_uses_direct_tls_with_ambient_proxies_set(self):
        with tempfile.TemporaryDirectory(prefix="codexia-direct-s3-") as temporary:
            directory = Path(temporary)
            certificate = directory / "fixture.crt"
            key = directory / "fixture.key"
            subprocess.run([
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                "-subj", "/CN=objects.example.test", "-addext", "subjectAltName=DNS:objects.example.test",
                "-out", str(certificate), "-keyout", str(key),
            ], check=True, capture_output=True)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certificate, key)
            sni_hosts = []
            context.sni_callback = lambda _socket, server_name, _context: sni_hosts.append(server_name)
            with serve_loopback(EndpointHandler, tls_context=context) as (endpoint, direct_requests):
                with serve_loopback(ProxyTrapHandler) as (trap, proxy_requests):
                    port = endpoint.rsplit(":", 1)[1]
                    origin = f"https://objects.example.test:{port}"
                    proxy = f"http://{trap}"
                    environment = {
                        "AWS_ACCESS_KEY_ID": "synthetic-fixture-id",
                        "AWS_SECRET_ACCESS_KEY": "synthetic-fixture-key",
                        "AWS_EC2_METADATA_DISABLED": "true",
                        "AWS_CONFIG_FILE": str(directory / "unused-config"),
                        "AWS_SHARED_CREDENTIALS_FILE": str(directory / "unused-credentials"),
                        "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "ALL_PROXY": proxy,
                        "http_proxy": proxy, "https_proxy": proxy, "all_proxy": proxy,
                        "NO_PROXY": "", "no_proxy": "",
                    }
                    with patch.dict(os.environ, environment, clear=True):
                        original_getaddrinfo = s3_transfer.socket.getaddrinfo

                        def resolve_test_endpoint(host, target_port, *args, **kwargs):
                            if host == "objects.example.test":
                                return [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", target_port))]
                            return original_getaddrinfo(host, target_port, *args, **kwargs)

                        with patch("s3_transfer.socket.getaddrinfo", side_effect=resolve_test_endpoint):
                            transfer = s3_transfer.S3BackupTransfer(
                                profile(endpointUrl=origin, allowedOrigins=[origin], caBundle=str(certificate)),
                                _allow_private_test_addresses=True,
                            )
                            try:
                                result = transfer.client.head_bucket(Bucket="codexia-fixture")
                            except Exception as error:
                                raise AssertionError(
                                    f"Direct TLS request failed ({type(error).__name__}), "
                                    f"proxy connections: {len(proxy_requests)}"
                                ) from None
                            finally:
                                transfer.client.close()
                    self.assertEqual(result["ResponseMetadata"]["HTTPStatusCode"], 200)
                    self.assertEqual(proxy_requests, [])
                    self.assertEqual(direct_requests, ["/codexia-fixture"])
                    self.assertEqual(sni_hosts, ["objects.example.test"])

    @unittest.skipUnless(find_spec("boto3"), "install the pinned S3 runtime for the real SDK test")
    def test_pinned_sdk_rejects_dns_rebinding_before_socket_connect(self):
        with tempfile.TemporaryDirectory(prefix="codexia-dns-rebinding-") as temporary:
            environment = {
                "AWS_ACCESS_KEY_ID": "synthetic-fixture-id",
                "AWS_SECRET_ACCESS_KEY": "synthetic-fixture-key",
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_CONFIG_FILE": str(Path(temporary) / "unused-config"),
                "AWS_SHARED_CREDENTIALS_FILE": str(Path(temporary) / "unused-credentials"),
            }
            origin = "https://objects.example.test"
            public_answer = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))]
            private_answer = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("127.0.0.1", 443))]
            answers = [public_answer]
            dns_hosts = []

            def resolve_rebinding(host, _port, **_kwargs):
                dns_hosts.append(host)
                return answers.pop(0) if answers else private_answer

            with patch.dict(os.environ, environment, clear=True):
                with patch("s3_transfer.socket.getaddrinfo", side_effect=resolve_rebinding):
                    transfer = s3_transfer.S3BackupTransfer(
                        profile(endpointUrl=origin, allowedOrigins=[origin])
                    )
                    try:
                        with patch("urllib3.util.connection.create_connection") as connect:
                            with self.assertRaisesRegex(s3_transfer.TransferError, "private"):
                                transfer.client.head_bucket(Bucket="codexia-fixture")
                        connect.assert_not_called()
                        self.assertGreaterEqual(dns_hosts.count("objects.example.test"), 2)
                    finally:
                        transfer.client.close()
