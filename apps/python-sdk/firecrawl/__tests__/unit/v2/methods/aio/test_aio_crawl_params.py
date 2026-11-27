from unittest.mock import AsyncMock

import httpx
import pytest
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.types import CrawlParamsRequest
from firecrawl.v2.methods.aio import crawl as aio_crawl


@pytest.mark.asyncio
async def test_crawl_params_request_validation():
    with pytest.raises(ValueError):
        await aio_crawl.crawl_params_preview(None, CrawlParamsRequest(url="", prompt="x"))
    with pytest.raises(ValueError):
        await aio_crawl.crawl_params_preview(None, CrawlParamsRequest(url="https://x", prompt=""))



@pytest.mark.asyncio
@pytest.mark.parametrize("field,value", [("limit", 25), ("delay", 3), ("delay", 0), ("integration", "example")])
async def test_public_preview_preserves_unrenamed_fields(field, value):
    client = AsyncFirecrawlClient(api_key="test")
    client.async_http_client.post = AsyncMock(return_value=httpx.Response(200, json={
        "success": True,
        "data": {field: value, "includePaths": ["/docs/*"]},
        "warning": "Review generated settings",
    }))
    try:
        result = await client.crawl_params_preview("https://example.com", "Find docs")
        assert getattr(result, field) == value
        assert result.include_paths == ["/docs/*"]
        assert result.warning == "Review generated settings"
        client.async_http_client.post.assert_awaited_once_with(
            "/v2/crawl/params-preview", {"url": "https://example.com", "prompt": "Find docs"}
        )
    finally:
        await client.async_http_client.close()
