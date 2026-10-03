"""
Unit tests for the async v2 extract methods.

Async mirror of the sync extract behavior: the async HTTP client is mocked and
the tests pin the request body, the error handling and the response
normalization. No network access.
"""

import asyncio
import warnings

import pytest

from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.methods.aio import extract as aio_extract
from firecrawl.v2.types import AgentOptions
from firecrawl.v2.utils.error_handler import PaymentRequiredError


class FakeResponse:
    def __init__(self, status_code=200, payload=None):
        self.status_code = status_code
        self._payload = {} if payload is None else payload
        self.text = str(self._payload)

    def json(self):
        return self._payload


class FakeAsyncHttpClient:
    def __init__(self, response):
        self.response = response
        self.posts = []
        self.gets = []

    async def post(self, path, body):
        self.posts.append((path, body))
        return self.response

    async def get(self, path):
        self.gets.append(path)
        return self.response


@pytest.fixture(autouse=True)
def _silence_deprecation():
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        yield


def test_start_extract_forwards_agent_options():
    client = FakeAsyncHttpClient(FakeResponse(200, {"success": True, "id": "job-1"}))
    result = asyncio.run(
        aio_extract.start_extract(
            client,
            ["https://example.com"],
            prompt="get the title",
            agent=AgentOptions(model="FIRE-1"),
        )
    )
    assert result.id == "job-1"
    path, body = client.posts[0]
    assert path == "/v2/extract"
    assert body["agent"] == {"model": "FIRE-1"}


def test_async_client_extract_accepts_agent_option():
    http = FakeAsyncHttpClient(FakeResponse(200, {"success": True, "id": "job-1"}))
    client = AsyncFirecrawlClient(api_key="fc-test", api_url="https://api.firecrawl.dev")
    client.async_http_client = http
    asyncio.run(
        client.start_extract(
            ["https://example.com"], prompt="p", agent=AgentOptions(model="FIRE-1")
        )
    )
    assert http.posts[0][1]["agent"] == {"model": "FIRE-1"}


def test_start_extract_raises_on_api_error():
    client = FakeAsyncHttpClient(
        FakeResponse(402, {"success": False, "error": "Insufficient credits"})
    )
    with pytest.raises(PaymentRequiredError):
        asyncio.run(aio_extract.start_extract(client, ["https://example.com"], prompt="p"))


def test_get_extract_status_raises_on_api_error():
    client = FakeAsyncHttpClient(
        FakeResponse(402, {"success": False, "error": "Insufficient credits"})
    )
    with pytest.raises(PaymentRequiredError):
        asyncio.run(aio_extract.get_extract_status(client, "job-1"))


def test_get_extract_status_normalizes_camel_case_fields():
    client = FakeAsyncHttpClient(
        FakeResponse(
            200,
            {
                "success": True,
                "id": "job-1",
                "status": "completed",
                "data": {"title": "x"},
                "expiresAt": "2026-01-01T00:00:00.000Z",
                "creditsUsed": 5,
                "tokensUsed": 120,
            },
        )
    )
    status = asyncio.run(aio_extract.get_extract_status(client, "job-1"))
    assert status.credits_used == 5
    assert status.tokens_used == 120
    assert status.expires_at is not None
