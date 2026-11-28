from unittest.mock import AsyncMock, Mock

import pytest

from firecrawl import AsyncFirecrawl, Firecrawl
from firecrawl.v2.utils import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient


@pytest.mark.asyncio
async def test_async_search_preserves_image_metadata(monkeypatch):
    image_url = "https://example.com/picture.jpg"
    response = Mock(status_code=200)
    response.json.return_value = {
        "success": True,
        "data": {
            "news": [{"title": "A news story", "imageUrl": image_url}],
            "images": [
                {
                    "title": "A picture",
                    "imageUrl": image_url,
                    "imageWidth": 640,
                    "imageHeight": 480,
                }
            ],
        },
    }
    monkeypatch.setattr(HttpClient, "post", Mock(return_value=response))
    monkeypatch.setattr(AsyncHttpClient, "post", AsyncMock(return_value=response))

    sync_result = Firecrawl(api_key="test").search("picture", sources=["news", "images"])
    async_result = await AsyncFirecrawl(api_key="test").search(
        "picture", sources=["news", "images"]
    )

    assert sync_result.news[0].image_url == image_url
    assert sync_result.images[0].image_width == 640
    assert sync_result.images[0].image_height == 480
    assert async_result.news == sync_result.news
    assert async_result.images == sync_result.images
