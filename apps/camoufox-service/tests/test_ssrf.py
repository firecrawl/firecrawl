"""SSRF policy tests for the Camoufox service.

Run with:  python -m unittest discover -s tests -v
"""

import asyncio
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ssrf import (  # noqa: E402
    InsecureConnectionError,
    SsrfGuardProxy,
    assert_safe_target_url,
    is_global_address,
    resolve_global_addresses,
)


class TestAddressClassification(unittest.TestCase):
    def test_blocks_loopback(self):
        for addr in ("127.0.0.1", "127.1.2.3", "::1"):
            self.assertFalse(is_global_address(addr), addr)

    def test_blocks_cloud_metadata_and_link_local(self):
        for addr in ("169.254.169.254", "169.254.0.1", "fe80::1", "fe80::a00:27ff:fe4e:66a1"):
            self.assertFalse(is_global_address(addr), addr)

    def test_blocks_rfc1918(self):
        for addr in ("10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.254",
                     "192.168.0.1", "192.168.0.107"):
            self.assertFalse(is_global_address(addr), addr)

    def test_blocks_ipv6_unique_local_and_unspecified(self):
        for addr in ("fc00::1", "fd12:3456:789a::1", "::", "0.0.0.0"):
            self.assertFalse(is_global_address(addr), addr)

    def test_blocks_multicast_reserved_and_cgnat(self):
        for addr in ("224.0.0.1", "239.255.255.255", "ff02::1",
                     "240.0.0.1", "100.64.0.1"):
            self.assertFalse(is_global_address(addr), addr)

    def test_blocks_ipv4_embedded_in_ipv6(self):
        # v4-mapped, 6to4 and Teredo must not smuggle a private destination past
        # the check by wearing an IPv6 costume.
        for addr in ("::ffff:127.0.0.1", "::ffff:169.254.169.254",
                     "::ffff:192.168.1.1", "2002:c0a8:0101::1"):
            self.assertFalse(is_global_address(addr), addr)

    def test_allows_public(self):
        for addr in ("1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"):
            self.assertTrue(is_global_address(addr), addr)

    def test_rejects_garbage(self):
        for addr in ("", "not-an-ip", "999.999.999.999", "127.0.0.1.1"):
            self.assertFalse(is_global_address(addr), addr)


class TestAssertSafeTargetUrl(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_non_http_schemes(self):
        for url in ("file:///etc/passwd", "gopher://x/", "ftp://example.com/",
                    "data:text/html,hi", "javascript:alert(1)"):
            with self.assertRaises(InsecureConnectionError, msg=url):
                await assert_safe_target_url(url)

    async def test_rejects_malformed(self):
        for url in ("", "http://", "not a url", "http://[::"):
            with self.assertRaises(InsecureConnectionError, msg=url):
                await assert_safe_target_url(url)

    async def test_rejects_literal_private_hosts(self):
        for url in (
            "http://127.0.0.1/",
            "http://127.0.0.1:8080/admin",
            "http://169.254.169.254/latest/meta-data/",
            "http://192.168.0.107:3002/v2/scrape",
            "http://10.0.0.5/",
            "http://172.17.0.1/",
            "http://[::1]/",
            "http://[fe80::1]/",
        ):
            with self.assertRaises(InsecureConnectionError, msg=url):
                await assert_safe_target_url(url)

    async def test_rejects_disallowed_port(self):
        # Globally routable, but not a web port.
        with self.assertRaises(InsecureConnectionError):
            await assert_safe_target_url("http://1.1.1.1:22/")

    async def test_public_name_resolving_to_private_ip_is_blocked(self):
        """The classic bypass: a public hostname whose A record points inward."""

        async def fake_getaddrinfo(host, port, **kwargs):
            return [(2, 1, 6, "", ("10.0.0.7", port))]

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", side_effect=fake_getaddrinfo):
            with self.assertRaises(InsecureConnectionError) as ctx:
                await assert_safe_target_url("https://totally-public.example.com/")
        self.assertIn("private/internal", str(ctx.exception))

    async def test_mixed_public_and_private_records_are_blocked(self):
        """One private record poisons the whole name.

        Rejecting the name outright — rather than filtering to the public
        record — is what stops a hostile resolver from mixing a good answer in
        with a bad one to win the race.
        """

        async def fake_getaddrinfo(host, port, **kwargs):
            return [
                (2, 1, 6, "", ("93.184.216.34", port)),
                (2, 1, 6, "", ("127.0.0.1", port)),
            ]

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", side_effect=fake_getaddrinfo):
            with self.assertRaises(InsecureConnectionError):
                await assert_safe_target_url("https://rebinding.example.com/")

    async def test_dns_failure_is_blocked_not_allowed(self):
        import socket

        async def fake_getaddrinfo(host, port, **kwargs):
            raise socket.gaierror("NXDOMAIN")

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", side_effect=fake_getaddrinfo):
            with self.assertRaises(InsecureConnectionError):
                await assert_safe_target_url("https://nonexistent.invalid/")

    async def test_allows_public_host(self):
        async def fake_getaddrinfo(host, port, **kwargs):
            return [(2, 1, 6, "", ("93.184.216.34", port))]

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", side_effect=fake_getaddrinfo):
            await assert_safe_target_url("https://example.com/some/path")

    async def test_resolution_returns_validated_addresses(self):
        async def fake_getaddrinfo(host, port, **kwargs):
            return [(2, 1, 6, "", ("93.184.216.34", port))]

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", side_effect=fake_getaddrinfo):
            resolved = await resolve_global_addresses("example.com", 443)
        self.assertEqual([addr for _f, addr in resolved], ["93.184.216.34"])


class TestRouteGuardCache(unittest.IsolatedAsyncioTestCase):
    """The cache is a latency fix for the route interceptor only."""

    def setUp(self):
        import ssrf

        ssrf._verdict_cache.clear()

    async def test_cache_avoids_repeat_resolution(self):
        calls = 0

        async def fake_getaddrinfo(host, port, **kwargs):
            nonlocal calls
            calls += 1
            return [(2, 1, 6, "", ("93.184.216.34", port))]

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", side_effect=fake_getaddrinfo):
            for _ in range(5):
                await assert_safe_target_url(
                    "https://example.com/asset.js", use_cache=True
                )
        self.assertEqual(calls, 1)

    async def test_cache_is_off_by_default(self):
        """Pre-navigation and proxy paths must always resolve for real."""
        calls = 0

        async def fake_getaddrinfo(host, port, **kwargs):
            nonlocal calls
            calls += 1
            return [(2, 1, 6, "", ("93.184.216.34", port))]

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", side_effect=fake_getaddrinfo):
            for _ in range(3):
                await assert_safe_target_url("https://example.com/")
        self.assertEqual(calls, 3)

    async def test_blocked_verdicts_are_cached_as_blocked(self):
        """A cached negative must keep blocking, never flip open."""

        async def fake_getaddrinfo(host, port, **kwargs):
            return [(2, 1, 6, "", ("10.0.0.7", port))]

        loop = asyncio.get_running_loop()
        with mock.patch.object(loop, "getaddrinfo", side_effect=fake_getaddrinfo):
            with self.assertRaises(InsecureConnectionError):
                await assert_safe_target_url("https://internal.example/", use_cache=True)
            # Second call is served from cache and must still raise.
            with self.assertRaises(InsecureConnectionError):
                await assert_safe_target_url("https://internal.example/", use_cache=True)


class TestProxyLifecycle(unittest.IsolatedAsyncioTestCase):
    async def test_stop_closes_idle_clients_and_drains_handler_tasks(self):
        proxy = SsrfGuardProxy()
        await proxy.start()
        reader, writer = await asyncio.open_connection("127.0.0.1", proxy.port)
        await asyncio.sleep(0)

        self.assertEqual(len(proxy._client_tasks), 1)
        self.assertEqual(len(proxy._client_writers), 1)

        await proxy.stop()

        self.assertEqual(proxy._client_tasks, set())
        self.assertEqual(proxy._client_writers, set())
        self.assertEqual(await asyncio.wait_for(reader.read(1), timeout=1), b"")
        writer.close()
        await writer.wait_closed()


if __name__ == "__main__":
    unittest.main()
