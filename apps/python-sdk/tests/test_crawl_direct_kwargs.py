"""Tests for direct scrape kwargs on crawl() and start_crawl()."""

import asyncio
import inspect

import pytest

from firecrawl.v2.client import FirecrawlClient, _SCRAPE_OPTION_KEYS
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.types import ScrapeOptions
import firecrawl.v2.methods.crawl as crawl_mod
from firecrawl.v2.methods.aio import crawl as async_crawl_mod


@pytest.fixture
def client():
    return FirecrawlClient(api_key="fc-test", api_url="http://localhost:9")


@pytest.fixture
def async_client():
    return AsyncFirecrawlClient(api_key="fc-test", api_url="http://localhost:9")


class TestSyncCrawlDirectKwargs:
    def test_crawl_signature_accepts_formats(self):
        sig = inspect.signature(FirecrawlClient.crawl)
        assert "formats" in sig.parameters

    def test_start_crawl_signature_accepts_formats(self):
        sig = inspect.signature(FirecrawlClient.start_crawl)
        assert "formats" in sig.parameters

    def test_direct_kwargs_build_scrape_options(self, client, monkeypatch):
        captured = {}

        def fake_start_crawl(http, request):
            captured["scrape_options"] = request.scrape_options
            raise ConnectionError("captured")

        monkeypatch.setattr(crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            client.start_crawl("https://example.com", formats=["markdown"])

        assert captured["scrape_options"] is not None
        fmt_strs = [str(f) for f in captured["scrape_options"].formats]
        assert "markdown" in fmt_strs

    def test_explicit_scrape_options_wins(self, client, monkeypatch):
        captured = {}

        def fake_start_crawl(http, request):
            captured["scrape_options"] = request.scrape_options
            raise ConnectionError("captured")

        monkeypatch.setattr(crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            client.start_crawl(
                "https://example.com",
                scrape_options=ScrapeOptions(formats=["html"]),
                formats=["markdown"],
            )

        fmt_strs = [str(f) for f in captured["scrape_options"].formats]
        assert "html" in fmt_strs
        assert "markdown" not in fmt_strs

    def test_no_scrape_kwargs_means_no_scrape_options(self, client, monkeypatch):
        captured = {}

        def fake_start_crawl(http, request):
            captured["scrape_options"] = request.scrape_options
            raise ConnectionError("captured")

        monkeypatch.setattr(crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            client.start_crawl("https://example.com", limit=10)

        assert captured["scrape_options"] is None

    def test_crawl_also_builds_scrape_options(self, client, monkeypatch):
        captured = {}

        def fake_crawl(http, request, poll_interval=2, timeout=None, request_timeout=None):
            captured["scrape_options"] = request.scrape_options
            raise ConnectionError("captured")

        monkeypatch.setattr(crawl_mod, "crawl", fake_crawl)

        with pytest.raises(ConnectionError):
            client.crawl("https://example.com", formats=["markdown"], only_main_content=True)

        assert captured["scrape_options"] is not None
        assert captured["scrape_options"].only_main_content is True

    def test_start_crawl_accepts_scrape_timeout(self, client, monkeypatch):
        captured = {}

        def fake_start_crawl(http, request):
            captured["scrape_options"] = request.scrape_options
            raise ConnectionError("captured")

        monkeypatch.setattr(crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            client.start_crawl("https://example.com", timeout=5000)

        assert captured["scrape_options"] is not None
        assert captured["scrape_options"].timeout == 5000

    def test_crawl_timeout_is_poll_timeout_not_scrape(self, client, monkeypatch):
        captured = {}

        def fake_crawl(http, request, poll_interval=2, timeout=None, request_timeout=None):
            captured["scrape_options"] = request.scrape_options
            captured["poll_timeout"] = timeout
            raise ConnectionError("captured")

        monkeypatch.setattr(crawl_mod, "crawl", fake_crawl)

        with pytest.raises(ConnectionError):
            client.crawl("https://example.com", timeout=60, formats=["markdown"])

        assert captured["poll_timeout"] == 60
        assert captured["scrape_options"] is not None
        assert captured["scrape_options"].timeout is None


class TestAsyncCrawlDirectKwargs:
    def test_async_direct_kwargs_build_scrape_options(self, async_client, monkeypatch):
        captured = {}

        async def fake_start_crawl(http, request):
            captured["scrape_options"] = request.scrape_options
            raise ConnectionError("captured")

        monkeypatch.setattr(async_crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            asyncio.get_event_loop().run_until_complete(
                async_client.start_crawl("https://example.com", formats=["markdown"])
            )

        assert captured["scrape_options"] is not None
        fmt_strs = [str(f) for f in captured["scrape_options"].formats]
        assert "markdown" in fmt_strs

    def test_async_explicit_scrape_options_wins(self, async_client, monkeypatch):
        captured = {}

        async def fake_start_crawl(http, request):
            captured["scrape_options"] = request.scrape_options
            raise ConnectionError("captured")

        monkeypatch.setattr(async_crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            asyncio.get_event_loop().run_until_complete(
                async_client.start_crawl(
                    "https://example.com",
                    scrape_options=ScrapeOptions(formats=["html"]),
                    formats=["markdown"],
                )
            )

        fmt_strs = [str(f) for f in captured["scrape_options"].formats]
        assert "html" in fmt_strs

    def test_async_integration_preserved_as_crawl_param(self, async_client, monkeypatch):
        captured = {}

        async def fake_start_crawl(http, request):
            captured["scrape_options"] = request.scrape_options
            captured["integration"] = request.integration
            raise ConnectionError("captured")

        monkeypatch.setattr(async_crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            asyncio.get_event_loop().run_until_complete(
                async_client.start_crawl(
                    "https://example.com",
                    formats=["markdown"],
                    integration="test-int",
                )
            )

        assert captured["integration"] == "test-int"
        assert captured["scrape_options"] is not None


class TestThreatProtectionDirectKwargs:
    EXPECTED_WIRE_PAYLOAD = {
        "mode": "normal",
        "riskScoreThreshold": 80,
        "blockedTlds": ["zip"],
    }

    @staticmethod
    def _threat_protection():
        from firecrawl.v2.types import ThreatProtectionOptions

        return ThreatProtectionOptions(
            mode="normal", risk_score_threshold=80, blocked_tlds=["zip"]
        )

    def test_sync_threat_protection_kwarg_lands_in_wire_body(self, client, monkeypatch):
        captured = {}

        def fake_start_crawl(http, request):
            captured["request"] = request
            raise ConnectionError("captured")

        monkeypatch.setattr(crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            client.start_crawl(
                "https://example.com",
                threat_protection=self._threat_protection(),
            )

        request = captured["request"]
        assert request.scrape_options is not None
        assert request.scrape_options.threat_protection is not None
        wire_body = crawl_mod._prepare_crawl_request(request)
        assert (
            wire_body["scrapeOptions"]["threatProtection"]
            == self.EXPECTED_WIRE_PAYLOAD
        )

    def test_async_threat_protection_kwarg_lands_in_wire_body(self, async_client, monkeypatch):
        captured = {}

        async def fake_start_crawl(http, request):
            captured["request"] = request
            raise ConnectionError("captured")

        monkeypatch.setattr(async_crawl_mod, "start_crawl", fake_start_crawl)

        with pytest.raises(ConnectionError):
            asyncio.get_event_loop().run_until_complete(
                async_client.start_crawl(
                    "https://example.com",
                    threat_protection=self._threat_protection(),
                )
            )

        request = captured["request"]
        assert request.scrape_options is not None
        assert request.scrape_options.threat_protection is not None
        wire_body = async_crawl_mod._prepare_crawl_request(request)
        assert (
            wire_body["scrapeOptions"]["threatProtection"]
            == self.EXPECTED_WIRE_PAYLOAD
        )

    def test_threat_protection_in_scrape_option_keys(self):
        assert "threat_protection" in _SCRAPE_OPTION_KEYS
