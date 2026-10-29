from unittest.mock import AsyncMock, Mock

import pytest
from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.utils.validation import prepare_scrape_options


@pytest.mark.asyncio
@pytest.mark.parametrize("asynchronous", [False, True])
@pytest.mark.parametrize(
    ("wire_name", "field_name", "value"),
    [
        ("includeTags", "include_tags", ["main"]),
        ("excludeTags", "exclude_tags", ["nav"]),
        ("onlyMainContent", "only_main_content", False),
        ("waitFor", "wait_for", 250),
        ("skipTlsVerification", "skip_tls_verification", False),
        ("removeBase64Images", "remove_base64_images", True),
    ],
)
async def test_preview_preserves_nested_scrape_options(
    asynchronous, wire_name, field_name, value
):
    client_type = AsyncFirecrawlClient if asynchronous else FirecrawlClient
    client = client_type(api_key="test-api-key")
    response = Mock(status_code=200, ok=True)
    response.json.return_value = {
        "success": True,
        "data": {
            "scrapeOptions": {
                wire_name: value,
                "formats": ["html"],
                "mobile": False,
            }
        },
    }
    http_client = client.async_http_client if asynchronous else client.http_client
    mock_type = AsyncMock if asynchronous else Mock
    http_client.post = mock_type(return_value=response)

    preview = client.crawl_params_preview("https://example.com", "Find articles")
    if asynchronous:
        preview = await preview

    assert getattr(preview.scrape_options, field_name) == value
    assert "html" in prepare_scrape_options(preview.scrape_options)["formats"]
    assert preview.scrape_options.mobile is False
    http_client.post.assert_called_once_with(
        "/v2/crawl/params-preview",
        {"url": "https://example.com", "prompt": "Find articles"},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [{}, {"scrapeOptions": None}])
async def test_preview_accepts_missing_or_null_scrape_options(data):
    client = AsyncFirecrawlClient(api_key="test-api-key")
    response = Mock(status_code=200)
    response.json.return_value = {"success": True, "data": data}
    client.async_http_client.post = AsyncMock(return_value=response)

    preview = await client.crawl_params_preview("https://example.com", "Find articles")

    assert preview.scrape_options is None
