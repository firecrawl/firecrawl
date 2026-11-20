"""Monitor pagination must stop before requesting a cursor twice."""

import asyncio
from types import SimpleNamespace
from urllib.parse import urlsplit, urlunsplit
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from firecrawl.v2.methods import monitor
from firecrawl.v2.methods.aio import monitor as async_monitor
from firecrawl.v2.types import MonitorCheckPage, PaginationConfig
from firecrawl.v2.utils.http_client import HttpClient
from firecrawl.v2.utils.http_client_async import AsyncHttpClient


FIRST = "/v2/monitor/monitor-id/checks/check-id"
CURSOR_A = FIRST + "?skip=1"
CURSOR_B = FIRST + "?skip=2"


def _page(page_id):
    return {
        "id": page_id,
        "targetId": "target-id",
        "url": "https://example.com/" + page_id,
        "status": "new",
        "createdAt": "2026-09-30T00:00:00Z",
    }


def _response(page_id, next_url=None):
    body = {"success": True, "data": {"pages": [_page(page_id)]}}
    if next_url is not None:
        body["next"] = next_url
    return MagicMock(ok=True, status_code=200, json=MagicMock(return_value=body))


@pytest.fixture(params=[False, True], ids=["sync", "async"])
def pagination(request):
    is_async = request.param
    module = async_monitor if is_async else monitor

    def invoke(client, next_url, initial_pages, config=None):
        result = module._fetch_all_monitor_check_pages(
            client, next_url, initial_pages, config
        )
        return asyncio.run(result) if is_async else result

    def client_for(responses):
        client = MagicMock()
        client._build_url.side_effect = lambda url: url
        client._client.build_request.side_effect = lambda method, url: SimpleNamespace(url=url)
        # Fail promptly if the implementation requests an unexpected extra page.
        # This keeps regression tests bounded even without cycle detection.
        remaining = iter(responses)

        def get_response(url):
            try:
                return next(remaining)
            except StopIteration:
                raise AssertionError("Unexpected repeated pagination request")

        client.get = AsyncMock(side_effect=get_response) if is_async else MagicMock(side_effect=get_response)
        return client

    return invoke, client_for


@pytest.mark.parametrize("cursors", [[CURSOR_A], [CURSOR_B, CURSOR_A]], ids=["self-loop", "two-cursor-cycle"])
def test_repeated_cursor_raises_before_refetch(pagination, cursors):
    invoke, client_for = pagination
    client = client_for([_response(str(i), cursor) for i, cursor in enumerate(cursors)])

    with pytest.raises(RuntimeError, match="Repeated pagination cursor"):
        invoke(client, CURSOR_A, [])

    assert [call.args[0] for call in client.get.call_args_list] == [CURSOR_A] + cursors[:-1]


def test_distinct_cursors_keep_all_pages(pagination):
    invoke, client_for = pagination
    initial = [MonitorCheckPage(**_page("initial"))]
    client = client_for([_response("a", CURSOR_B), _response("b")])

    pages = invoke(client, CURSOR_A, initial)

    assert [page.id for page in pages] == ["initial", "a", "b"]
    assert [page.id for page in initial] == ["initial"]
    assert [call.args[0] for call in client.get.call_args_list] == [CURSOR_A, CURSOR_B]


@pytest.mark.parametrize("config", [PaginationConfig(max_pages=1), PaginationConfig(max_results=2)])
def test_limits_stop_without_refetch_or_cycle_error(pagination, config):
    invoke, client_for = pagination
    client = client_for([_response("a", CURSOR_A)])

    pages = invoke(client, CURSOR_A, [MonitorCheckPage(**_page("initial"))], config)

    assert [page.id for page in pages] == ["initial", "a"]
    client.get.assert_called_once_with(CURSOR_A)


def test_zero_page_limit_makes_no_request(pagination):
    invoke, client_for = pagination
    client = client_for([])

    assert invoke(client, CURSOR_A, [], PaginationConfig(max_pages=0)) == []
    client.get.assert_not_called()


def test_time_limit_makes_no_request(pagination, monkeypatch):
    invoke, client_for = pagination
    client = client_for([])
    ticks = iter([0, 2])
    clock = SimpleNamespace(monotonic=lambda: next(ticks))
    monkeypatch.setattr(monitor, "time", clock)
    monkeypatch.setattr(async_monitor, "time", clock)

    assert invoke(client, CURSOR_A, [], PaginationConfig(max_wait_time=1)) == []
    client.get.assert_not_called()


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("auto_paginate", [False, True], ids=["manual", "auto"])
def test_get_monitor_check_pagination_mode(is_async, auto_paginate):
    module = async_monitor if is_async else monitor
    detail = {
        "id": "check-id",
        "monitorId": "monitor-id",
        "status": "completed",
        "trigger": "manual",
        "billingStatus": "confirmed",
        "summary": {"totalPages": 1},
        "createdAt": "2026-09-30T00:00:00Z",
        "updatedAt": "2026-09-30T00:00:00Z",
        "pages": [_page("initial")],
    }
    initial_response = MagicMock(ok=True, status_code=200, json=MagicMock(
        return_value={"success": True, "data": detail, "next": CURSOR_A}
    ))
    get = AsyncMock if is_async else MagicMock
    client = MagicMock()
    client._build_url.side_effect = lambda url: url
    client._client.build_request.side_effect = lambda method, url: SimpleNamespace(url=url)
    client.get = get(side_effect=[initial_response, _response("a", CURSOR_A)])

    def call():
        result = module.get_monitor_check(
            client, "monitor-id", "check-id",
            pagination_config=PaginationConfig(auto_paginate=auto_paginate),
        )
        return asyncio.run(result) if is_async else result

    if auto_paginate:
        with pytest.raises(RuntimeError, match="Repeated pagination cursor"):
            call()
        assert [c.args[0] for c in client.get.call_args_list] == [FIRST, CURSOR_A]
    else:
        result = call()
        assert result.next == CURSOR_A
        assert [page.id for page in result.pages] == ["initial"]
        client.get.assert_called_once_with(FIRST)


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
@pytest.mark.parametrize("api_url", ["https://api.firecrawl.dev", "https://self-hosted.example/api"])
@pytest.mark.parametrize("entry_form", ["relative", "absolute", "cross-host"])
@pytest.mark.parametrize("direct_cycle", [False, True], ids=["via-next-page", "direct-entry-repeat"])
def test_entry_url_is_not_requested_twice(is_async, api_url, entry_form, direct_cycle):
    module = async_monitor if is_async else monitor
    # Use the real transport's URL builder without opening a network session.
    transport = object.__new__(AsyncHttpClient if is_async else HttpClient)
    transport.api_url = api_url
    if is_async:
        transport._client = httpx.AsyncClient(base_url=api_url)
    entry = FIRST + "?limit=1&skip=0&status=new"
    resolved_entry = str(transport._client.build_request("GET", transport._build_url(entry)).url) if is_async else transport._build_url(entry)
    parsed_entry = urlsplit(resolved_entry)
    repeated_entry = {
        "relative": entry,
        "absolute": resolved_entry,
        "cross-host": urlunsplit(parsed_entry._replace(netloc="other.example")),
    }[entry_form]
    detail = {
        "id": "check-id", "monitorId": "monitor-id", "status": "completed",
        "trigger": "manual", "billingStatus": "confirmed", "summary": {},
        "createdAt": "2026-09-30T00:00:00Z", "updatedAt": "2026-09-30T00:00:00Z",
        "pages": [_page("initial")],
    }
    initial = MagicMock(ok=True, status_code=200, json=MagicMock(return_value={
        "success": True, "data": detail,
        "next": repeated_entry if direct_cycle else CURSOR_A,
    }))
    client = MagicMock()
    client._build_url.side_effect = transport._build_url
    if is_async:
        client._client = transport._client
    get = AsyncMock if is_async else MagicMock
    client.get = get(side_effect=[initial] if direct_cycle else [initial, _response("a", repeated_entry)])

    with pytest.raises(RuntimeError, match="Repeated pagination cursor"):
        result = module.get_monitor_check(client, "monitor-id", "check-id", limit=1, skip=0, status="new")
        if is_async:
            asyncio.run(result)

    expected = [entry] if direct_cycle else [entry, CURSOR_A]
    assert [call.args[0] for call in client.get.call_args_list] == expected
    if is_async:
        asyncio.run(transport.close())
