import pytest
from firecrawl.v2.types import MapOptions
from firecrawl.v2.methods.aio.map import _prepare_map_request


class TestAsyncMapRequestPreparation:
    def test_basic(self):
        payload = _prepare_map_request("https://example.com")
        assert payload["url"] == "https://example.com"

    def test_fields(self):
        opts = MapOptions(search="docs", include_subdomains=True, limit=10, sitemap="only", timeout=15000, integration="  _unit-test  ")
        payload = _prepare_map_request("https://example.com", opts)
        assert payload["search"] == "docs"
        assert payload["includeSubdomains"] is True
        assert payload["limit"] == 10
        assert payload["sitemap"] == "only"
        assert payload["timeout"] == 15000
        assert payload["integration"] == "_unit-test"


    def test_blank_integration_is_omitted(self):
        payload = _prepare_map_request("https://example.com", MapOptions(integration="   "))
        assert "integration" not in payload


class TestAsyncMapClientOptions:
    @pytest.mark.asyncio
    async def test_forwards_ignore_query_parameters_and_location(self):
        from unittest.mock import AsyncMock, MagicMock
        from firecrawl.v2.client_async import AsyncFirecrawlClient
        from firecrawl.v2.types import Location

        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {"success": True, "links": []}
        client = AsyncFirecrawlClient(api_key="test-key", api_url="https://api.firecrawl.dev")
        client.async_http_client.post = AsyncMock(return_value=response)

        await client.map(
            "https://example.com",
            ignore_query_parameters=True,
            location=Location(country="US", languages=["en"]),
        )

        endpoint, payload = client.async_http_client.post.await_args.args
        assert endpoint == "/v2/map"
        assert payload["ignoreQueryParameters"] is True
        assert payload["location"] == {"country": "US", "languages": ["en"]}
