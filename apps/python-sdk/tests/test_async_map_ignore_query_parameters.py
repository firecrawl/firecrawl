from unittest.mock import AsyncMock, Mock

import pytest

from firecrawl import AsyncFirecrawl


@pytest.mark.asyncio
@pytest.mark.parametrize("ignore_query_parameters", [True, False, None])
async def test_async_map_ignore_query_parameters(monkeypatch, ignore_query_parameters):
    client = AsyncFirecrawl(api_key="test")
    response = Mock(status_code=200)
    response.json.return_value = {"success": True, "links": []}
    post = AsyncMock(return_value=response)
    monkeypatch.setattr(client._v2_client.async_http_client, "post", post)
    url = "https://example.com"

    if ignore_query_parameters is None:
        await client.map(url)
        post.assert_awaited_once_with("/v2/map", {"url": url})
    else:
        await client.map(url, ignore_query_parameters=ignore_query_parameters)
        post.assert_awaited_once_with(
            "/v2/map",
            {"url": url, "sitemap": "include", "ignoreQueryParameters": ignore_query_parameters},
        )
