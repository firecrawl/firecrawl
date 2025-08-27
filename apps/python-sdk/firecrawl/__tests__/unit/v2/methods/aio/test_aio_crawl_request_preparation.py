from firecrawl.v2.types import CrawlRequest, ScrapeOptions, WebhookConfig
from firecrawl.v2.methods.aio.crawl import _prepare_crawl_request


class TestAsyncCrawlRequestPreparation:
    def test_basic_request(self):
        req = CrawlRequest(url="https://example.com")
        payload = _prepare_crawl_request(req)
        assert payload["url"] == "https://example.com"

    def test_field_mappings(self):
        req = CrawlRequest(
            url="https://example.com",
            include_paths=["/docs/*"],
            exclude_paths=["/admin/*"],
            max_discovery_depth=2,
            sitemap="skip",
            ignore_query_parameters=True,
            crawl_entire_domain=True,
            allow_external_links=False,
            allow_subdomains=True,
            max_concurrency=5,
            zero_data_retention=True,
        )
        payload = _prepare_crawl_request(req)
        assert payload["includePaths"] == ["/docs/*"]
        assert payload["excludePaths"] == ["/admin/*"]
        assert payload["maxDiscoveryDepth"] == 2
        assert payload["sitemap"] == "skip"
        assert payload["ignoreQueryParameters"] is True
        assert payload["crawlEntireDomain"] is True
        assert payload["allowExternalLinks"] is False
        assert payload["allowSubdomains"] is True
        assert payload["maxConcurrency"] == 5
        assert payload["zeroDataRetention"] is True

    def test_webhook_preparation(self):
        # string webhook
        req = CrawlRequest(url="https://example.com", webhook="https://example.com/hook")
        payload = _prepare_crawl_request(req)
        assert payload["webhook"] == "https://example.com/hook"

        # object webhook
        req2 = CrawlRequest(url="https://example.com", webhook=WebhookConfig(url="https://x/h", headers={"X": "1"}, events=["completed"]))
        payload2 = _prepare_crawl_request(req2)
        assert isinstance(payload2["webhook"], dict)
        assert payload2["webhook"]["url"] == "https://x/h"
        assert payload2["webhook"]["headers"] == {"X": "1"}

    def test_webhook_none_values_excluded(self):
        req = CrawlRequest(
            url="https://example.com",
            webhook=WebhookConfig(url="https://example.com/webhook", headers=None, metadata=None, events=None),
        )
        payload = _prepare_crawl_request(req)
        webhook = payload["webhook"]
        assert webhook["url"] == "https://example.com/webhook"
        assert "headers" not in webhook
        assert "metadata" not in webhook
        assert "events" not in webhook

