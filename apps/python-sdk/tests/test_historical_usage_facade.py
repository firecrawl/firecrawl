"""Historical usage is available through the public unified clients."""

import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import requests

from firecrawl import AsyncFirecrawl, Firecrawl
from firecrawl.v2.utils.error_handler import UnauthorizedError


@pytest.mark.parametrize("resource,field", [("credit", "creditsUsed"), ("token", "tokensUsed")])
@pytest.mark.parametrize("by_api_key", [None, False, True])
def test_sync_historical_usage(resource, field, by_api_key):
    client = Firecrawl(api_key="test-key")
    response = requests.Response()
    response.status_code = 200
    response._content = json.dumps({"success": True, "periods": [{field: 42}]}).encode()
    kwargs = {} if by_api_key is None else {"by_api_key": by_api_key}

    with patch.object(client._v2_client.http_client, "get", return_value=response) as get:
        result = getattr(client, f"get_{resource}_usage_historical")(**kwargs)

    suffix = "?byApiKey=true" if by_api_key else ""
    get.assert_called_once_with(f"/v2/team/{resource}-usage/historical{suffix}")
    assert result.success is True
    assert getattr(result.periods[0], field) == 42


@pytest.mark.asyncio
@pytest.mark.parametrize("resource,field", [("credit", "creditsUsed"), ("token", "tokensUsed")])
@pytest.mark.parametrize("by_api_key", [None, False, True])
async def test_async_historical_usage(resource, field, by_api_key):
    client = AsyncFirecrawl(api_key="test-key")
    transport = client._v2_client.async_http_client
    response = httpx.Response(200, json={"success": True, "periods": [{field: 42}]})
    kwargs = {} if by_api_key is None else {"by_api_key": by_api_key}
    try:
        with patch.object(transport, "get", new_callable=AsyncMock, return_value=response) as get:
            result = await getattr(client, f"get_{resource}_usage_historical")(**kwargs)

        suffix = "?byApiKey=true" if by_api_key else ""
        get.assert_awaited_once_with(f"/v2/team/{resource}-usage/historical{suffix}")
        assert result.success is True
        assert getattr(result.periods[0], field) == 42
    finally:
        await transport.close()


@pytest.mark.parametrize("resource", ["credit", "token"])
def test_sync_historical_usage_preserves_api_errors(resource):
    client = Firecrawl(api_key="test-key")
    response = requests.Response()
    response.status_code = 401
    response._content = b'{"success": false, "error": "Invalid API key"}'
    with patch.object(client._v2_client.http_client, "get", return_value=response):
        with pytest.raises(UnauthorizedError, match="Invalid API key"):
            getattr(client, f"get_{resource}_usage_historical")()


@pytest.mark.asyncio
@pytest.mark.parametrize("resource", ["credit", "token"])
async def test_async_historical_usage_preserves_api_errors(resource):
    client = AsyncFirecrawl(api_key="test-key")
    transport = client._v2_client.async_http_client
    response = httpx.Response(401, json={"success": False, "error": "Invalid API key"})
    try:
        with patch.object(transport, "get", new_callable=AsyncMock, return_value=response):
            with pytest.raises(UnauthorizedError, match="Invalid API key"):
                await getattr(client, f"get_{resource}_usage_historical")()
    finally:
        await transport.close()
