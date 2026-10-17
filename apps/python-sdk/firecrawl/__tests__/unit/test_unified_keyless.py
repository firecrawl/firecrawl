import httpx
import pytest
import requests

from firecrawl import AsyncFirecrawl, Firecrawl


@pytest.fixture(autouse=True)
def clear_firecrawl_api_key_env(monkeypatch):
    monkeypatch.delenv("FIRECRAWL_API_KEY", raising=False)
    yield


def test_keyless_cloud_scrape_and_search(monkeypatch):
    calls = []

    def post(url, *, headers, json, timeout):
        calls.append((url, headers))
        response = requests.Response()
        response.status_code = 200
        response._content = (
            b'{"success":true,"data":{"markdown":"hello"}}'
            if url.endswith("/scrape") else b'{"success":true,"data":{"web":[]}}'
        )
        return response

    monkeypatch.setattr(requests, "post", post)
    client = Firecrawl()
    assert client.v1 is None
    assert client.scrape("https://example.com").markdown == "hello"
    assert client.search("example").web == []
    assert [url for url, _ in calls] == [
        "https://api.firecrawl.dev/v2/scrape",
        "https://api.firecrawl.dev/v2/search",
    ]
    assert all("Authorization" not in headers for _, headers in calls)


@pytest.mark.asyncio
async def test_async_keyless_cloud_scrape_and_search():
    calls = []

    def handle(request):
        calls.append(request)
        data = {"markdown": "hello"} if request.url.path.endswith("/scrape") else {"web": []}
        return httpx.Response(200, json={"success": True, "data": data})

    client = AsyncFirecrawl()
    assert client.v1 is None
    await client._v2_client.async_http_client.close()
    client._v2_client.async_http_client._client = httpx.AsyncClient(
        transport=httpx.MockTransport(handle), base_url="https://api.firecrawl.dev"
    )
    try:
        assert (await client.scrape("https://example.com")).markdown == "hello"
        assert (await client.search("example")).web == []
        assert [request.url.path for request in calls] == ["/v2/scrape", "/v2/search"]
        assert all("Authorization" not in request.headers for request in calls)
    finally:
        await client._v2_client.async_http_client.close()


@pytest.mark.asyncio
async def test_keyed_cloud_keeps_v1_available():
    assert Firecrawl(api_key="fc-test").v1 is not None
    client = AsyncFirecrawl(api_key="fc-test")
    assert client.v1 is not None
    await client._v2_client.async_http_client.close()
