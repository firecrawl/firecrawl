import pytest

from firecrawl.v1.client import AsyncV1FirecrawlApp


@pytest.mark.asyncio
async def test_async_batch_scrape_urls_accepts_parsed_json_response(monkeypatch):
    client = AsyncV1FirecrawlApp(api_key="fc-test", api_url="http://localhost:9")
    captured = {}

    async def fake_post_request(url, data, headers):
        captured["url"] = url
        captured["data"] = data
        captured["headers"] = headers
        return {
            "success": True,
            "id": "batch-123",
            "url": "http://localhost:9/v1/batch/scrape/batch-123",
        }

    async def fail_handle_error(*_args, **_kwargs):
        raise AssertionError("_handle_error should not run for parsed success JSON")

    monkeypatch.setattr(client, "_async_post_request", fake_post_request)
    monkeypatch.setattr(client, "_handle_error", fail_handle_error)

    result = await client.async_batch_scrape_urls(["https://example.com"])

    assert result.success is True
    assert result.id == "batch-123"
    assert result.url == "http://localhost:9/v1/batch/scrape/batch-123"
    assert captured["url"] == "http://localhost:9/v1/batch/scrape"
    assert captured["data"]["urls"] == ["https://example.com"]
    assert captured["data"]["origin"].startswith("python-sdk@")
