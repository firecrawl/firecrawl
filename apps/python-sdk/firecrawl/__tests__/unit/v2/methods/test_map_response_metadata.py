"""The map response must expose the server's request ID and guidance."""

from unittest.mock import AsyncMock, Mock

import pytest

from firecrawl.v2.methods.map import map as map_urls
from firecrawl.v2.methods.aio.map import map as async_map_urls


def _response():
    response = Mock(ok=True, status_code=200)
    response.json.return_value = {
        "success": True,
        "id": "map-job-id",
        "warning": "Try mapping the base domain for broader coverage.",
        "links": ["https://example.com/page"],
    }
    return response


def _assert_metadata(result):
    assert result.id == "map-job-id"
    assert result.warning == "Try mapping the base domain for broader coverage."
    assert result.links[0].url == "https://example.com/page"
    assert result.model_dump(exclude_none=True)["id"] == "map-job-id"


def test_sync_map_preserves_response_metadata():
    client = Mock()
    client.post.return_value = _response()
    _assert_metadata(map_urls(client, "https://example.com"))


@pytest.mark.asyncio
async def test_async_map_preserves_response_metadata():
    client = Mock()
    client.post = AsyncMock(return_value=_response())
    _assert_metadata(await async_map_urls(client, "https://example.com"))
