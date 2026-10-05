from unittest.mock import AsyncMock, Mock

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient


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


def _response():
    response = Mock()
    response.status_code = 200
    response.json.return_value = RESPONSE
    return response


def test_legal_regulatory_search_posts_query_and_k_and_parses_web_results():
    transport = Mock()
    transport.post.return_value = _response()
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport

    result = client.legal_regulatory_search("food labeling requirements", k=5)

    transport.post.assert_called_once_with(
        "/v2/search/gov", {"query": "food labeling requirements", "k": 5}
    )
    assert result.data.web[0].title == "21 CFR Part 101 -- Food Labeling"
    assert result.data.web[0].position == 1


def test_legal_regulatory_search_omits_k_when_not_provided():
    transport = Mock()
    transport.post.return_value = _response()
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport

    client.legal_regulatory_search("zoning variance")

    transport.post.assert_called_once_with(
        "/v2/search/gov", {"query": "zoning variance"}
    )


def test_legal_regulatory_search_rejects_empty_query():
    transport = Mock()
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport

    with pytest.raises(ValueError, match="query cannot be empty"):
        client.legal_regulatory_search("  ")
    transport.post.assert_not_called()


@pytest.mark.asyncio
async def test_async_legal_regulatory_search_posts_query_and_k():
    transport = Mock()
    transport.post = AsyncMock(return_value=_response())
    client = AsyncFirecrawlClient.__new__(AsyncFirecrawlClient)
    client.async_http_client = transport

    result = await client.legal_regulatory_search("food labeling requirements", k=5)

    transport.post.assert_awaited_once_with(
        "/v2/search/gov", {"query": "food labeling requirements", "k": 5}
    )
    assert result.data.web[0].url.startswith("https://www.ecfr.gov/")
