"""An ambiguous gateway failure must not replay a billable operation."""

from unittest.mock import Mock

import httpx
import pytest
import requests

from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient


WRITE_REQUESTS = [
    ("post", {"data": {"url": "https://example.com"}}, "post"),
    ("post_multipart", {"data": {}, "files": {"file": b"data"}}, "post"),
    ("patch", {"data": {"name": "updated"}}, "patch"),
    ("delete", {}, "delete"),
]


@pytest.mark.parametrize("method,kwargs,transport", WRITE_REQUESTS)
def test_sync_write_does_not_retry_ambiguous_502(monkeypatch, method, kwargs, transport):
    calls = []

    def request(*args, **request_kwargs):
        calls.append((args, request_kwargs))
        return Mock(status_code=502)

    monkeypatch.setattr(requests, transport, request)
    client = HttpClient("fc-test", "https://api.firecrawl.dev", max_retries=3)

    response = getattr(client, method)("/v2/test", **kwargs)

    assert response.status_code == 502
    assert len(calls) == 1


@pytest.mark.parametrize("method,kwargs,transport", WRITE_REQUESTS)
def test_sync_write_does_not_retry_network_error(monkeypatch, method, kwargs, transport):
    calls = []

    def request(*args, **request_kwargs):
        calls.append((args, request_kwargs))
        raise requests.ConnectionError("response lost")

    monkeypatch.setattr(requests, transport, request)
    client = HttpClient("fc-test", "https://api.firecrawl.dev", max_retries=3)

    with pytest.raises(requests.ConnectionError, match="response lost"):
        getattr(client, method)("/v2/test", **kwargs)

    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("method,kwargs,transport", WRITE_REQUESTS)
async def test_async_write_does_not_retry_ambiguous_502(monkeypatch, method, kwargs, transport):
    calls = []

    async def request(*args, **request_kwargs):
        calls.append((args, request_kwargs))
        return httpx.Response(502)

    client = AsyncHttpClient("fc-test", "https://api.firecrawl.dev", max_retries=3)
    try:
        monkeypatch.setattr(client._client, transport, request)
        response = await getattr(client, method)("/v2/test", **kwargs)
        assert response.status_code == 502
        assert len(calls) == 1
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("method,kwargs,transport", WRITE_REQUESTS)
async def test_async_write_does_not_retry_network_error(monkeypatch, method, kwargs, transport):
    calls = []

    async def request(*args, **request_kwargs):
        calls.append((args, request_kwargs))
        raise httpx.ConnectError("response lost")

    client = AsyncHttpClient("fc-test", "https://api.firecrawl.dev", max_retries=3)
    try:
        monkeypatch.setattr(client._client, transport, request)
        with pytest.raises(httpx.ConnectError, match="response lost"):
            await getattr(client, method)("/v2/test", **kwargs)
        assert len(calls) == 1
    finally:
        await client.close()


def test_sync_get_retries_remain_available(monkeypatch):
    calls = []

    def get(*args, **kwargs):
        calls.append((args, kwargs))
        return Mock(status_code=502 if len(calls) == 1 else 200)

    monkeypatch.setattr(requests, "get", get)
    client = HttpClient("fc-test", "https://api.firecrawl.dev", max_retries=2, backoff_factor=0)

    assert client.get("/v2/test").status_code == 200
    assert len(calls) == 2


@pytest.mark.parametrize("method,kwargs,transport", WRITE_REQUESTS)
def test_sync_write_retries_when_explicitly_requested(monkeypatch, method, kwargs, transport):
    calls = []

    def request(*args, **request_kwargs):
        calls.append((args, request_kwargs))
        return Mock(status_code=502 if len(calls) == 1 else 200)

    monkeypatch.setattr(requests, transport, request)
    client = HttpClient("fc-test", "https://api.firecrawl.dev", max_retries=3, backoff_factor=0)

    assert getattr(client, method)("/v2/test", **kwargs, retries=2).status_code == 200
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_async_get_retries_remain_available(monkeypatch):
    calls = []

    async def get(*args, **kwargs):
        calls.append((args, kwargs))
        return httpx.Response(502 if len(calls) == 1 else 200)

    client = AsyncHttpClient("fc-test", "https://api.firecrawl.dev", max_retries=2, backoff_factor=0)
    try:
        monkeypatch.setattr(client._client, "get", get)
        assert (await client.get("/v2/test")).status_code == 200
        assert len(calls) == 2
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("method,kwargs,transport", WRITE_REQUESTS)
async def test_async_write_retries_when_explicitly_requested(monkeypatch, method, kwargs, transport):
    calls = []

    async def request(*args, **request_kwargs):
        calls.append((args, request_kwargs))
        return httpx.Response(502 if len(calls) == 1 else 200)

    client = AsyncHttpClient("fc-test", "https://api.firecrawl.dev", max_retries=3, backoff_factor=0)
    try:
        monkeypatch.setattr(client._client, transport, request)
        assert (await getattr(client, method)("/v2/test", **kwargs, retries=2)).status_code == 200
        assert len(calls) == 2
    finally:
        await client.close()
