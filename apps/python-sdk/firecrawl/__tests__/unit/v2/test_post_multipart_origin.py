"""Ensure multipart posts include SDK origin for telemetry parity."""

from unittest.mock import MagicMock, AsyncMock, patch

from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient


def test_sync_post_multipart_injects_origin():
    client = HttpClient(api_key="k", api_url="https://api.test")
    with patch("firecrawl.v2.utils.http_client.requests.post") as mock_post:
        mock_post.return_value = MagicMock(status_code=200)
        client.post_multipart("/v2/parse", data={"foo": "bar"}, files={})

        _, kwargs = mock_post.call_args
        assert kwargs["data"]["origin"].startswith("python-sdk@")
        assert kwargs["data"]["foo"] == "bar"


def test_sync_post_multipart_does_not_override_existing_origin():
    client = HttpClient(api_key="k", api_url="https://api.test")
    with patch("firecrawl.v2.utils.http_client.requests.post") as mock_post:
        mock_post.return_value = MagicMock(status_code=200)
        client.post_multipart("/v2/parse", data={"origin": "custom"}, files={})
        _, kwargs = mock_post.call_args
        assert kwargs["data"]["origin"] == "custom"


def test_async_post_multipart_injects_origin():
    import asyncio

    async def _run():
        client = AsyncHttpClient(api_key="k", api_url="https://api.test")
        # patch the underlying httpx client
        mock_resp = MagicMock(status_code=200)
        with patch.object(client._client, "post", new=AsyncMock(return_value=mock_resp)) as mock_post:
            await client.post_multipart("/v2/parse", data={"foo": "bar"}, files={})
            _, kwargs = mock_post.call_args
            assert kwargs["data"]["origin"].startswith("python-sdk@")

    asyncio.run(_run())


def test_async_post_multipart_does_not_override_existing_origin():
    import asyncio

    async def _run():
        client = AsyncHttpClient(api_key="k", api_url="https://api.test")
        mock_resp = MagicMock(status_code=200)
        with patch.object(client._client, "post", new=AsyncMock(return_value=mock_resp)) as mock_post:
            await client.post_multipart("/v2/parse", data={"origin": "custom"}, files={})
            _, kwargs = mock_post.call_args
            assert kwargs["data"]["origin"] == "custom"

    asyncio.run(_run())
