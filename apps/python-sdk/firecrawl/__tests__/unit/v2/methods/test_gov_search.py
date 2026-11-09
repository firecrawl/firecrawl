from unittest.mock import AsyncMock, Mock

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.utils.error_handler import FirecrawlError


RESPONSE = {
    "success": True,
    "data": {
        "web": [
            {
                "url": "https://www.ecfr.gov/current/title-21/chapter-I/subchapter-B/part-101",
                "title": "21 CFR Part 101 -- Food Labeling",
                "description": "matched snippet",
                "position": 1,
            }
        ]
    },
}


FAILED = {"success": False, "error": "Search failed"}


def _response(body=RESPONSE):
    response = Mock()
    response.status_code = 200
    response.json.return_value = body
    return response


@pytest.mark.parametrize(
    "kwargs, body",
    [
        ({"k": 5}, {"query": "food labeling requirements", "k": 5}),
        ({}, {"query": "food labeling requirements"}),
    ],
)
def test_gov_search_posts_body_and_parses_web_results(kwargs, body):
    transport = Mock()
    transport.post.return_value = _response()
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport

    result = client.gov_search("food labeling requirements", **kwargs)

    transport.post.assert_called_once_with("/v2/search/gov", body)
    assert result.data.web[0].title == "21 CFR Part 101 -- Food Labeling"
    assert result.data.web[0].position == 1


def test_gov_search_rejects_empty_query():
    transport = Mock()
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport

    with pytest.raises(ValueError, match="query cannot be empty"):
        client.gov_search("  ")
    transport.post.assert_not_called()


@pytest.mark.asyncio
async def test_async_gov_search_posts_query_and_k():
    transport = Mock()
    transport.post = AsyncMock(return_value=_response())
    client = AsyncFirecrawlClient.__new__(AsyncFirecrawlClient)
    client.async_http_client = transport

    result = await client.gov_search("food labeling requirements", k=5)

    transport.post.assert_awaited_once_with(
        "/v2/search/gov", {"query": "food labeling requirements", "k": 5}
    )
    assert result.data.web[0].url.startswith("https://www.ecfr.gov/")


def test_gov_search_raises_on_unsuccessful_body():
    transport = Mock()
    transport.post.return_value = _response(FAILED)
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport

    with pytest.raises(FirecrawlError, match="Search failed"):
        client.gov_search("zoning variance")
