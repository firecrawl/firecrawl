import pytest
from firecrawl.v2.types import ScrapeOptions, Location
from firecrawl.v2.methods.aio.scrape import _prepare_scrape_request


class TestAsyncScrapeRequestPreparation:
    @pytest.mark.asyncio
    async def test_basic_request_preparation(self):
        payload = await _prepare_scrape_request("https://example.com", None)
        assert payload["url"] == "https://example.com"

    @pytest.mark.asyncio
    async def test_options_conversion(self):
        opts = ScrapeOptions(
            formats=["markdown", {"type": "screenshot", "full_page": True, "quality": 80}],
            include_tags=["main"],
            exclude_tags=["nav"],
            only_main_content=True,
            wait_for=500,
            timeout=30000,
            mobile=True,
            parsers=["pdf"],
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
        payload = await _prepare_scrape_request("https://example.com", opts)
        assert payload["url"] == "https://example.com"
        assert isinstance(payload.get("formats"), list) and "markdown" in payload["formats"]
        assert payload["includeTags"] == ["main"]
        assert payload["excludeTags"] == ["nav"]
        assert payload["onlyMainContent"] is True
        assert payload["waitFor"] == 500
        assert payload["timeout"] == 30000
        assert payload["mobile"] is True
        assert payload["skipTlsVerification"] is False
        assert payload["removeBase64Images"] is False
        assert payload["fastMode"] is True
        assert payload["useMock"] == "test"
        assert payload["blockAds"] is False
        assert payload["proxy"] == "basic"
        assert payload["maxAge"] == 1000
        assert payload["storeInCache"] is False

