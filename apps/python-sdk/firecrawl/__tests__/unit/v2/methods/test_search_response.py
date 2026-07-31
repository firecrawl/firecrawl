import pytest
from unittest.mock import AsyncMock, Mock

from firecrawl.v2.types import SearchRequest, SearchResultWeb
from firecrawl.v2.methods.search import search
from firecrawl.v2.methods.aio.search import search as search_async


def _response(data):
    response = Mock()
    response.status_code = 200
    response.json.return_value = {"success": True, "data": data}
    return response


DEVELOPER_PAYLOAD = {
    "web": [{"title": "W", "url": "http://a.com", "description": "d"}],
    "developer": [
        {
            "title": "https://github.com/firecrawl/firecrawl/issues/1",
            "url": "https://github.com/firecrawl/firecrawl/issues/1",
            "description": "passage",
            "position": 1,
            "category": "developer",
        }
    ],
}


class TestSearchDeveloperResults:
    """Unit tests for the developer category results."""

    def test_developer_results_are_parsed(self):
        client = Mock()
        client.post.return_value = _response(DEVELOPER_PAYLOAD)

        result = search(client, SearchRequest(query="test", categories=["developer"]))

        assert len(result.web) == 1
        assert len(result.developer) == 1
        assert isinstance(result.developer[0], SearchResultWeb)
        assert result.developer[0].url == "https://github.com/firecrawl/firecrawl/issues/1"
        assert result.developer[0].position == 1
        assert result.developer[0].category == "developer"

    def test_developer_absent_when_not_returned(self):
        client = Mock()
        client.post.return_value = _response({"web": []})

        result = search(client, SearchRequest(query="test"))

        assert result.developer is None

    def test_data_property_lists_developer(self):
        client = Mock()
        client.post.return_value = _response({"developer": DEVELOPER_PAYLOAD["developer"]})

        result = search(client, SearchRequest(query="test", categories=["developer"]))

        with pytest.raises(AttributeError, match=r"\.developer \(1 results\)"):
            result.data

    @pytest.mark.asyncio
    async def test_developer_results_are_parsed_async(self):
        client = Mock()
        client.post = AsyncMock(return_value=_response(DEVELOPER_PAYLOAD))

        result = await search_async(
            client, SearchRequest(query="test", categories=["developer"])
        )

        assert len(result.developer) == 1
        assert result.developer[0].url == "https://github.com/firecrawl/firecrawl/issues/1"
