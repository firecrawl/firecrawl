from firecrawl.v2.types import (
    CrawlRequest,
    MapOptions,
    ScrapeOptions,
    SearchRequest,
    ThreatProtectionOptions,
)
from firecrawl.v2.methods.aio.agent import _prepare_agent_request
from firecrawl.v2.methods.aio.batch import _prepare as _prepare_batch_request
from firecrawl.v2.methods.aio.crawl import _prepare_crawl_request
from firecrawl.v2.methods.aio.extract import _prepare_extract_request
from firecrawl.v2.methods.aio.map import _prepare_map_request
from firecrawl.v2.methods.aio.search import _prepare_search_request


EXPECTED_WIRE_PAYLOAD = {
    "mode": "normal",
    "riskScoreThreshold": 80,
    "blacklist": ["*.blocked.example.com"],
    "whitelist": ["allowed.example.com"],
    "blockedTlds": ["zip"],
    "failurePolicy": "open",
}


def _threat_protection() -> ThreatProtectionOptions:
    return ThreatProtectionOptions(
        mode="normal",
        risk_score_threshold=80,
        blacklist=["*.blocked.example.com"],
        whitelist=["allowed.example.com"],
        blocked_tlds=["zip"],
        failure_policy="open",
    )


class TestAioThreatProtectionRequestPreparation:
    """The aio request preparers must serialize threat_protection too."""

    def test_batch_scrape_top_level(self):
        data = _prepare_batch_request(
            ["https://example.com"],
            options=ScrapeOptions(threat_protection=_threat_protection()),
        )
        assert data["threatProtection"] == EXPECTED_WIRE_PAYLOAD
        assert "threat_protection" not in data

    def test_crawl_scrape_options(self):
        request = CrawlRequest(
            url="https://example.com",
            scrape_options=ScrapeOptions(threat_protection=_threat_protection()),
        )
        data = _prepare_crawl_request(request)
        assert data["scrapeOptions"]["threatProtection"] == EXPECTED_WIRE_PAYLOAD

    def test_search_top_level_and_scrape_options(self):
        request = SearchRequest(
            query="firecrawl",
            threat_protection=_threat_protection(),
            scrape_options=ScrapeOptions(threat_protection=_threat_protection()),
        )
        data = _prepare_search_request(request)
        assert data["threatProtection"] == EXPECTED_WIRE_PAYLOAD
        assert data["scrapeOptions"]["threatProtection"] == EXPECTED_WIRE_PAYLOAD
        assert "threat_protection" not in data

    def test_map_top_level(self):
        options = MapOptions(threat_protection=_threat_protection())
        data = _prepare_map_request("https://example.com", options)
        assert data["threatProtection"] == EXPECTED_WIRE_PAYLOAD
        assert "threat_protection" not in data

    def test_extract_top_level(self):
        data = _prepare_extract_request(
            ["https://example.com"],
            prompt="extract",
            threat_protection=_threat_protection(),
        )
        assert data["threatProtection"] == EXPECTED_WIRE_PAYLOAD

    def test_agent_top_level(self):
        data = _prepare_agent_request(
            None,
            prompt="find pricing",
            threat_protection=_threat_protection(),
        )
        assert data["threatProtection"] == EXPECTED_WIRE_PAYLOAD
