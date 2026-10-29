import asyncio
import unittest
from fastapi import HTTPException

from main import PublicOnlyResolver, normalize_public_url


class PublicUrlValidationTests(unittest.TestCase):
    def test_normalizes_scheme_host_default_port_and_fragment(self):
        result = normalize_public_url(
            "HTTPS://Example.COM:443/articles/one?x=1#section",
            resolve_dns=False,
        )
        self.assertEqual(result, "https://example.com/articles/one?x=1")

    def test_adds_root_path(self):
        result = normalize_public_url("https://example.com", resolve_dns=False)
        self.assertEqual(result, "https://example.com/")

    def test_rejects_non_http_scheme(self):
        with self.assertRaises(HTTPException):
            normalize_public_url("file:///etc/passwd", resolve_dns=False)

    def test_rejects_credentials(self):
        with self.assertRaises(HTTPException):
            normalize_public_url("https://user:pass@example.com/", resolve_dns=False)

    def test_rejects_local_hostname(self):
        with self.assertRaises(HTTPException):
            normalize_public_url("http://localhost:8000/", resolve_dns=False)

    def test_rejects_loopback_ipv4(self):
        with self.assertRaises(HTTPException):
            normalize_public_url("http://127.0.0.1/", resolve_dns=False)

    def test_rejects_private_ipv4(self):
        with self.assertRaises(HTTPException):
            normalize_public_url("http://192.168.1.10/", resolve_dns=False)

    def test_rejects_loopback_ipv6(self):
        with self.assertRaises(HTTPException):
            normalize_public_url("http://[::1]/", resolve_dns=False)

    def test_rejects_invalid_port(self):
        with self.assertRaises(HTTPException):
            normalize_public_url("https://example.com:99999/", resolve_dns=False)

    def test_rejects_backslashes(self):
        with self.assertRaises(HTTPException):
            normalize_public_url("https://example.com\\@127.0.0.1/", resolve_dns=False)

    def test_connection_time_resolver_rejects_loopback(self):
        resolver = PublicOnlyResolver()
        with self.assertRaises(OSError):
            asyncio.run(resolver.resolve("127.0.0.1", 80))


if __name__ == "__main__":
    unittest.main()
