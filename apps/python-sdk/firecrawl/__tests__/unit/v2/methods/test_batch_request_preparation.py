import pytest
from firecrawl.v2.types import ScrapeOptions, Location, WebhookConfig
from firecrawl.v2.methods.batch import prepare_batch_scrape_request


class TestBatchScrapeRequestPreparation:
    """Unit tests for batch scrape request preparation."""

    def test_urls_validation(self):
        # empty list
        with pytest.raises(ValueError):
            prepare_batch_scrape_request([])
        # invalid protocol
        with pytest.raises(ValueError):
            prepare_batch_scrape_request(["example.com"])  # missing http(s)
        # valid
        data = prepare_batch_scrape_request(["https://example.com", "http://foo.bar"])
        assert data["urls"] == ["https://example.com", "http://foo.bar"]

    def test_flatten_scrape_options(self):
        opts = ScrapeOptions(
            formats=["markdown", "change_tracking", {"type": "screenshot", "full_page": True, "quality": 80}],
            include_tags=["main"],
            exclude_tags=["nav"],
            only_main_content=True,
            wait_for=500,
            timeout=30000,
            mobile=True,
            parsers=["pdf"],
            actions=[{"type": "screenshot", "full_page": True}],
            location=Location(country="us", languages=["en"]),
            skip_tls_verification=False,
            remove_base64_images=False,
            fast_mode=True,
            use_mock="test",
            block_ads=False,
            proxy="basic",
            max_age=1000,
            store_in_cache=False,
        )
        data = prepare_batch_scrape_request(["https://example.com"], options=opts)

        # Formats should be at top-level as list, with screenshot normalized to object w/ fullPage
        assert isinstance(data.get("formats"), list)
        assert "markdown" in data["formats"]
        # snake_case format should be converted to camelCase
        assert "changeTracking" in data["formats"]
        found_obj = next((f for f in data["formats"] if isinstance(f, dict) and f.get("type") == "screenshot"), None)
        assert found_obj is not None and found_obj.get("fullPage") is True and found_obj.get("quality") == 80

        # Field conversions to camelCase
        assert data["includeTags"] == ["main"]
        assert data["excludeTags"] == ["nav"]
        assert data["onlyMainContent"] is True
        assert data["waitFor"] == 500
        assert data["timeout"] == 30000
        assert data["mobile"] is True
        assert data["parsers"] == ["pdf"]
        assert isinstance(data["actions"], list) and data["actions"][0]["type"] == "screenshot"
        assert isinstance(data["location"], dict) and data["location"]["country"] == "us"
        assert data["skipTlsVerification"] is False
        assert data["removeBase64Images"] is False
        assert data["fastMode"] is True
        assert data["useMock"] == "test"
        assert data["blockAds"] is False
        assert data["proxy"] == "basic"
        assert data["maxAge"] == 1000
        assert data["storeInCache"] is False

    def test_batch_specific_fields(self):
        webhook = WebhookConfig(url="https://hook.test", headers={"X": "Y"}, events=["completed"]) 
        data = prepare_batch_scrape_request(
            ["https://example.com"],
            webhook=webhook,
            append_to_id="00000000-0000-0000-0000-000000000000",
            ignore_invalid_urls=True,
            max_concurrency=5,
            zero_data_retention=True,
            integration="test",
        )
        assert isinstance(data["webhook"], dict) and data["webhook"]["url"] == "https://hook.test"
        assert data["appendToId"] == "00000000-0000-0000-0000-000000000000"
        assert data["ignoreInvalidURLs"] is True
        assert data["maxConcurrency"] == 5
        assert data["zeroDataRetention"] is True
        assert data["integration"] == "test"

    def test_string_webhook_is_passed_verbatim(self):
        data = prepare_batch_scrape_request(["https://example.com"], webhook="https://hook.simple")
        assert data["webhook"] == "https://hook.simple"