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


QUESTION_SCRAPE_RESULT = {
    "url": "https://example.com/product",
    "title": "Example product",
    "answer": "$19",
    "metadata": {
        "sourceURL": "https://example.com/product",
        "statusCode": 200,
    },
}

IMAGES_SCRAPE_RESULT = {
    "url": "https://example.com/gallery",
    "title": "Example gallery",
    "images": ["https://example.com/product1.png", "https://example.com/product2.png"],
    "metadata": {
        "sourceURL": "https://example.com/gallery",
        "statusCode": 200,
    },
}

METADATA_ONLY_SCRAPE_RESULT = {
    "url": "https://example.com/error-page",
    "title": "Error page",
    "metadata": {
        "sourceURL": "https://example.com/error-page",
        "statusCode": 500,
        "error": "Failed to scrape content",
    },
}


class TestSearchScrapedContentPreservation:
    """Unit tests verifying search-plus-scrape output preservation (issue #5146)."""

    def test_search_with_question_format_preserves_answer_and_metadata(self):
        from firecrawl.v2.types import Document

        client = Mock()
        client.post.return_value = _response({"web": [QUESTION_SCRAPE_RESULT]})

        result = search(client, SearchRequest(query="price of product"))

        assert len(result.web) == 1
        item = result.web[0]
        assert isinstance(item, Document)
        assert getattr(item, "answer", None) == "$19"
        assert getattr(item, "url", None) == "https://example.com/product"
        assert getattr(item, "title", None) == "Example product"
        assert item.metadata is not None
        assert item.metadata.status_code == 200
        assert item.metadata.source_url == "https://example.com/product"

    def test_search_with_images_format_preserves_page_images(self):
        from firecrawl.v2.types import Document

        client = Mock()
        client.post.return_value = _response({"web": [IMAGES_SCRAPE_RESULT]})

        result = search(client, SearchRequest(query="gallery"))

        assert len(result.web) == 1
        item = result.web[0]
        assert isinstance(item, Document)
        assert getattr(item, "images", None) == [
            "https://example.com/product1.png",
            "https://example.com/product2.png",
        ]
        assert getattr(item, "url", None) == "https://example.com/gallery"
        assert getattr(item, "title", None) == "Example gallery"
        assert item.metadata is not None
        assert item.metadata.status_code == 200

    def test_search_with_metadata_only_scrape_failure_preserved_as_document(self):
        from firecrawl.v2.types import Document

        client = Mock()
        client.post.return_value = _response({"web": [METADATA_ONLY_SCRAPE_RESULT]})

        result = search(client, SearchRequest(query="error"))

        assert len(result.web) == 1
        item = result.web[0]
        assert isinstance(item, Document)
        assert item.metadata is not None
        assert item.metadata.status_code == 500
        assert getattr(item, "url", None) == "https://example.com/error-page"

    @pytest.mark.asyncio
    async def test_search_async_with_question_format_preserves_answer(self):
        from firecrawl.v2.types import Document

        client = Mock()
        client.post = AsyncMock(return_value=_response({"web": [QUESTION_SCRAPE_RESULT]}))

        result = await search_async(client, SearchRequest(query="price"))

        assert len(result.web) == 1
        item = result.web[0]
        assert isinstance(item, Document)
        assert getattr(item, "answer", None) == "$19"
        assert getattr(item, "url", None) == "https://example.com/product"
        assert item.metadata is not None
        assert item.metadata.status_code == 200

    def test_search_news_and_images_groups_with_scrape_preserves_document(self):
        from firecrawl.v2.types import Document, SearchDocument

        client = Mock()
        client.post.return_value = _response({
            "news": [QUESTION_SCRAPE_RESULT],
            "images": [IMAGES_SCRAPE_RESULT],
        })

        result = search(client, SearchRequest(query="news and images"))

        assert len(result.news) == 1
        assert isinstance(result.news[0], Document)
        assert isinstance(result.news[0], SearchDocument)
        assert result.news[0].answer == "$19"
        assert result.news[0].url == "https://example.com/product"

        assert len(result.images) == 1
        assert isinstance(result.images[0], Document)
        assert isinstance(result.images[0], SearchDocument)
        assert result.images[0].images == [
            "https://example.com/product1.png",
            "https://example.com/product2.png",
        ]
        assert result.images[0].url == "https://example.com/gallery"

    def test_plain_search_across_groups_retains_specific_types(self):
        from firecrawl.v2.types import SearchResultWeb, SearchResultNews, SearchResultImages, Document

        plain_web = {"url": "https://example.com/w", "title": "Web Title", "position": 1}
        plain_news = {"url": "https://example.com/n", "title": "News Title", "imageUrl": "https://example.com/thumb.jpg"}
        plain_img = {"url": "https://example.com/i", "title": "Img Title", "imageUrl": "https://example.com/pic.jpg", "imageWidth": 800}

        client = Mock()
        client.post.return_value = _response({
            "web": [plain_web],
            "news": [plain_news],
            "images": [plain_img],
        })

        result = search(client, SearchRequest(query="plain"))

        assert isinstance(result.web[0], SearchResultWeb)
        assert not isinstance(result.web[0], Document)
        assert result.web[0].title == "Web Title"

        assert isinstance(result.news[0], SearchResultNews)
        assert not isinstance(result.news[0], Document)
        assert result.news[0].image_url == "https://example.com/thumb.jpg"

        assert isinstance(result.images[0], SearchResultImages)
        assert not isinstance(result.images[0], Document)
        assert result.images[0].image_url == "https://example.com/pic.jpg"
        assert result.images[0].image_width == 800

    def test_search_document_serialization_round_trip(self):
        from firecrawl.v2.types import SearchDocument

        client = Mock()
        client.post.return_value = _response({"web": [QUESTION_SCRAPE_RESULT]})

        result = search(client, SearchRequest(query="price"))
        doc = result.web[0]
        assert isinstance(doc, SearchDocument)

        dumped = doc.model_dump(exclude_none=True)
        assert dumped["answer"] == "$19"
        assert dumped["url"] == "https://example.com/product"
        assert dumped["title"] == "Example product"
        assert dumped["metadata"]["status_code"] == 200

        recreated = SearchDocument.model_validate(dumped)
        assert recreated.answer == "$19"
        assert recreated.url == "https://example.com/product"

    def test_search_with_highlights_and_blocks_preserved_as_document(self):
        from firecrawl.v2.types import Document, SearchDocument
        from firecrawl.types import SearchDocument as ExportedSearchDocument

        assert ExportedSearchDocument is SearchDocument

        highlights_result = {
            "url": "https://example.com/highlight-page",
            "title": "Highlight page",
            "highlights": "Key takeaway point",
            "imageUrl": "https://example.com/thumb.jpg",
            "imageWidth": 640,
            "imageHeight": 480,
        }
        blocks_result = {
            "url": "https://example.com/block-page",
            "title": "Block page",
            "blocks": [],
        }

        client = Mock()
        client.post.return_value = _response({"web": [highlights_result, blocks_result]})

        result = search(client, SearchRequest(query="highlights"))
        assert len(result.web) == 2

        item1 = result.web[0]
        assert isinstance(item1, Document)
        assert isinstance(item1, SearchDocument)
        assert getattr(item1, "highlights", None) == "Key takeaway point"
        assert item1.image_url == "https://example.com/thumb.jpg"
        assert item1.image_width == 640
        assert item1.image_height == 480

        item2 = result.web[1]
        assert isinstance(item2, Document)
        assert getattr(item2, "blocks", None) == []
