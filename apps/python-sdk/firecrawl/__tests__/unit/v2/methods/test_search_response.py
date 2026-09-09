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


# Developer results arrive in the exact web schema; nothing extra on the wire.
DEVELOPER_RESULT = {
    "title": "Retry requests",
    "url": "https://github.com/firecrawl/firecrawl/issues/1",
    "description": "passage",
    "position": 1,
    "category": "developer",
}


class TestSearchDeveloperResults:
    """Unit tests for developer category results in the web group."""

    def test_developer_results_are_parsed_inside_web(self):
        client = Mock()
        client.post.return_value = _response({"web": [DEVELOPER_RESULT]})

        result = search(client, SearchRequest(query="test", categories=["developer"]))

        assert len(result.web) == 1
        assert isinstance(result.web[0], SearchResultWeb)
        assert result.web[0].url.endswith("/issues/1")
        assert result.web[0].category == "developer"
        assert not hasattr(result.web[0], "passages")
        assert not hasattr(result, "developer")

    def test_data_property_lists_developer_results_as_web(self):
        client = Mock()
        client.post.return_value = _response({"web": [DEVELOPER_RESULT]})

        result = search(client, SearchRequest(query="test", categories=["developer"]))

        with pytest.raises(AttributeError, match=r"\.web \(1 results\)"):
            result.data

    @pytest.mark.asyncio
    async def test_developer_results_are_parsed_inside_web_async(self):
        client = Mock()
        client.post = AsyncMock(return_value=_response({"web": [DEVELOPER_RESULT]}))

        result = await search_async(
            client, SearchRequest(query="test", categories=["developer"])
        )

        assert len(result.web) == 1
        assert isinstance(result.web[0], SearchResultWeb)
        assert result.web[0].category == "developer"
        assert not hasattr(result, "developer")
