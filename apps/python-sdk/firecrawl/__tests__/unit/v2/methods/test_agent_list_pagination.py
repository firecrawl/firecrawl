"""Public agent-list cursor forwarding, isolated from the HTTP transport."""

import json
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qs, urlencode, urlparse

import pytest
from requests import Response

from firecrawl import AsyncFirecrawl, BadRequestError, Firecrawl


API_URL = "https://api.example.test"
BEFORE = 1792051200000
FIRST_ID = "00000000-0000-0000-0000-000000000020"
SECOND_ID = "00000000-0000-0000-0000-000000000019"


def _page_response(endpoint):
    query = parse_qs(urlparse(endpoint).query)
    if not query:
        agent_id = FIRST_ID
        next_url = f"{API_URL}/v2/agent?" + urlencode(
            {"before": BEFORE, "beforeId": FIRST_ID}
        )
    else:
        assert query == {"before": [str(BEFORE)], "beforeId": [FIRST_ID]}
        agent_id = SECOND_ID
        next_url = None
    response = Response()
    response.status_code = 200
    response._content = json.dumps(
        {
            "success": True,
            "agents": [
                {
                    "id": agent_id,
                    "createdAt": "2026-10-15T08:00:00.000Z",
                    "targetHint": "Find the pricing",
                }
            ],
            "next": next_url,
        }
    ).encode()
    return response


@pytest.mark.parametrize("v2_surface", [False, True])
def test_list_agents_preserves_same_timestamp_cursor(monkeypatch, v2_surface):
    client = Firecrawl(api_key="fc-test-key", api_url=API_URL)
    get = Mock(side_effect=_page_response)
    monkeypatch.setattr(client._v2_client.http_client, "get", get)
    surface = client.v2 if v2_surface else client

    first = surface.list_agents()
    cursor = parse_qs(urlparse(first.next).query)
    second = surface.list_agents(
        before=int(cursor["before"][0]), before_id=cursor["beforeId"][0]
    )

    assert [item.id for page in (first, second) for item in page.agents] == [
        FIRST_ID, SECOND_ID
    ]
    assert second.next is None
    assert get.call_count == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("v2_surface", [False, True])
async def test_list_agents_async_preserves_same_timestamp_cursor(monkeypatch, v2_surface):
    client = AsyncFirecrawl(api_key="fc-test-key", api_url=API_URL)
    http = client._v2_client.async_http_client
    get = AsyncMock(side_effect=_page_response)
    monkeypatch.setattr(http, "get", get)
    surface = client.v2 if v2_surface else client
    try:
        first = await surface.list_agents()
        cursor = parse_qs(urlparse(first.next).query)
        second = await surface.list_agents(
            before=int(cursor["before"][0]), before_id=cursor["beforeId"][0]
        )

        assert [item.id for page in (first, second) for item in page.agents] == [
            FIRST_ID, SECOND_ID
        ]
        assert second.next is None
        assert get.await_count == 2
    finally:
        await http.close()


@pytest.mark.parametrize(
    "kwargs, endpoint",
    [
        ({}, "/v2/agent"),
        ({"before": 0}, "/v2/agent?before=0"),
        ({"before": BEFORE}, f"/v2/agent?before={BEFORE}"),
    ],
)
def test_list_agents_retains_timestamp_only_requests(monkeypatch, kwargs, endpoint):
    client = Firecrawl(api_key="fc-test-key", api_url=API_URL)
    get = Mock(return_value=_page_response("/v2/agent"))
    monkeypatch.setattr(client._v2_client.http_client, "get", get)

    client.list_agents(**kwargs)

    get.assert_called_once_with(endpoint)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs, endpoint",
    [
        ({}, "/v2/agent"),
        ({"before": 0}, "/v2/agent?before=0"),
        ({"before": BEFORE}, f"/v2/agent?before={BEFORE}"),
    ],
)
async def test_list_agents_async_retains_timestamp_only_requests(monkeypatch, kwargs, endpoint):
    client = AsyncFirecrawl(api_key="fc-test-key", api_url=API_URL)
    http = client._v2_client.async_http_client
    get = AsyncMock(return_value=_page_response("/v2/agent"))
    monkeypatch.setattr(http, "get", get)
    try:
        await client.list_agents(**kwargs)
        get.assert_awaited_once_with(endpoint)
    finally:
        await http.close()


def _bad_cursor_response():
    response = Response()
    response.status_code = 400
    response._content = b'{"success": false, "error": "Invalid beforeId cursor."}'
    return response


@pytest.mark.parametrize("cursor", ["invalid", "invalid&before=0/+"])
def test_list_agents_preserves_cursor_error(monkeypatch, cursor):
    client = Firecrawl(api_key="fc-test-key", api_url=API_URL)
    get = Mock(return_value=_bad_cursor_response())
    monkeypatch.setattr(client._v2_client.http_client, "get", get)

    with pytest.raises(BadRequestError, match="Invalid beforeId cursor"):
        client.list_agents(before=BEFORE, before_id=cursor)
    assert parse_qs(urlparse(get.call_args.args[0]).query) == {
        "before": [str(BEFORE)], "beforeId": [cursor]
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("cursor", ["invalid", "invalid&before=0/+"])
async def test_list_agents_async_preserves_cursor_error(monkeypatch, cursor):
    client = AsyncFirecrawl(api_key="fc-test-key", api_url=API_URL)
    http = client._v2_client.async_http_client
    get = AsyncMock(return_value=_bad_cursor_response())
    monkeypatch.setattr(http, "get", get)
    try:
        with pytest.raises(BadRequestError, match="Invalid beforeId cursor"):
            await client.list_agents(before=BEFORE, before_id=cursor)
        assert parse_qs(urlparse(get.call_args.args[0]).query) == {
            "before": [str(BEFORE)], "beforeId": [cursor]
        }
    finally:
        await http.close()
