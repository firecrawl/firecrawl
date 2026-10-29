import asyncio

from firecrawl.v1.client import AsyncV1FirecrawlApp


def test_async_batch_scrape_urls_accepts_parsed_json_response(monkeypatch):
    app = AsyncV1FirecrawlApp(api_key="fc-test", api_url="http://localhost:9")
    calls = []

    async def fake_post_request(url, data, headers):
        calls.append((url, data, headers))
        return {
            "success": True,
            "id": "batch-123",
            "url": "http://localhost:9/v1/batch/scrape/batch-123",
        }

    async def fail_handle_error(response, action):
        raise AssertionError(f"unexpected error path: {action} {response!r}")

    monkeypatch.setattr(app, "_async_post_request", fake_post_request)
    monkeypatch.setattr(app, "_handle_error", fail_handle_error)

    result = asyncio.run(app.async_batch_scrape_urls(["https://example.com"]))

    assert result.success is True
    assert result.id == "batch-123"
    assert result.url == "http://localhost:9/v1/batch/scrape/batch-123"
    assert calls[0][1]["urls"] == ["https://example.com"]
