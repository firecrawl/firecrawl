"""Agent safe option and response parity through public v2 surfaces."""

import json

import httpx
import pytest
import requests
from pydantic import ValidationError

from firecrawl import AsyncFirecrawl, Firecrawl
from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.types import AgentListResponse, AgentResponse, AgentThreadRun


_OMITTED = object()


def _status_payload(safe=_OMITTED):
    payload = {
        "success": True,
        "id": "agent-1",
        "status": "completed",
        "data": {"answer": "value"},
    }
    if safe is not _OMITTED:
        payload["safe"] = safe
    return payload


def _list_payload(safe=_OMITTED):
    options = {"prompt": "p", "model": "spark-2"}
    if safe is not _OMITTED:
        options["safe"] = safe
    return {
        "success": True,
        "agents": [{"id": "agent-1", "createdAt": "2030-01-01T00:00:00Z", "targetHint": "example", "status": "completed", "options": options}],
    }


class _SyncTransport:
    def __init__(self, status_safe=_OMITTED, list_safe=_OMITTED):
        self.posts = []
        self.gets = []
        self.status_safe = status_safe
        self.list_safe = list_safe

    @staticmethod
    def _response(payload):
        response = requests.Response()
        response.status_code = 200
        response._content = json.dumps(payload).encode()
        return response

    def post(self, endpoint, payload):
        self.posts.append((endpoint, payload))
        return self._response({"success": True, "id": "agent-1", "status": "processing"})

    def get(self, endpoint):
        self.gets.append(endpoint)
        payload = _list_payload(self.list_safe) if endpoint == "/v2/agent" else _status_payload(self.status_safe)
        return self._response(payload)


class _AsyncTransport(_SyncTransport):
    async def post(self, endpoint, payload):
        self.posts.append((endpoint, payload))
        return httpx.Response(200, json={"success": True, "id": "agent-1", "status": "processing"})

    async def get(self, endpoint):
        self.gets.append(endpoint)
        payload = _list_payload(self.list_safe) if endpoint == "/v2/agent" else _status_payload(self.status_safe)
        return httpx.Response(200, json=payload)


def _arguments(safe):
    kwargs = {"prompt": "p", "max_credits": 7, "location": {"country": "DE"}, "zero_data_retention": True, "thread_id": "00000000-0000-4000-8000-000000000001"}
    if safe is not _OMITTED:
        kwargs["safe"] = safe
    return kwargs


def _assert_request(transport, safe):
    assert len(transport.posts) == 1
    endpoint, payload = transport.posts[0]
    assert endpoint == "/v2/agent"
    assert payload["prompt"] == "p"
    assert payload["maxCredits"] == 7
    assert payload["location"] == {"country": "DE"}
    assert payload["zeroDataRetention"] is True
    assert payload["threadId"] == "00000000-0000-4000-8000-000000000001"
    if safe is _OMITTED or safe is None:
        assert "safe" not in payload
    else:
        assert payload["safe"] is safe


@pytest.mark.parametrize("safe", [_OMITTED, None, False, True], ids=["omitted", "none", "false", "true"])
@pytest.mark.parametrize("method", ["start_agent", "agent"])
def test_sync_public_v2_agent_safe_request(method, safe):
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = transport = _SyncTransport()
    result = getattr(client, method)(**_arguments(safe))
    assert result.success is True
    _assert_request(transport, safe)
    assert len(transport.gets) == (1 if method == "agent" else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("safe", [_OMITTED, None, False, True], ids=["omitted", "none", "false", "true"])
@pytest.mark.parametrize("method", ["start_agent", "agent"])
async def test_async_public_v2_agent_safe_request(method, safe):
    client = AsyncFirecrawlClient.__new__(AsyncFirecrawlClient)
    client.async_http_client = transport = _AsyncTransport()
    result = await getattr(client, method)(**_arguments(safe))
    assert result.success is True
    _assert_request(transport, safe)
    assert len(transport.gets) == (1 if method == "agent" else 0)


@pytest.mark.parametrize("surface", ["top", "v2"])
@pytest.mark.parametrize("method", ["start_agent", "agent"])
@pytest.mark.parametrize("safe", [False, True])
def test_top_level_sync_wrappers_forward_agent_safe(surface, method, safe):
    client = Firecrawl(api_key="synthetic", api_url="http://localhost")
    client._v2_client.http_client = transport = _SyncTransport()
    api = client if surface == "top" else client.v2
    result = getattr(api, method)(**_arguments(safe))
    assert result.success is True
    _assert_request(transport, safe)


@pytest.mark.asyncio
@pytest.mark.parametrize("surface", ["top", "v2"])
@pytest.mark.parametrize("method", ["start_agent", "agent"])
@pytest.mark.parametrize("safe", [False, True])
async def test_top_level_async_wrappers_forward_agent_safe(surface, method, safe):
    client = AsyncFirecrawl(api_key="synthetic", api_url="http://localhost")
    old_transport = client._v2_client.async_http_client
    try:
        client._v2_client.async_http_client = transport = _AsyncTransport()
        api = client if surface == "top" else client.v2
        result = await getattr(api, method)(**_arguments(safe))
        assert result.success is True
        _assert_request(transport, safe)
    finally:
        await old_transport.close()


@pytest.mark.parametrize("safe", [_OMITTED, None, False, True], ids=["omitted", "synthetic-null", "false", "true"])
@pytest.mark.parametrize("method", ["get_agent_status", "agent"])
def test_sync_agent_status_preserves_safe(method, safe):
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = _SyncTransport(status_safe=safe)
    result = client.get_agent_status("agent-1") if method == "get_agent_status" else client.agent(prompt="p")
    assert result.safe is (None if safe is _OMITTED else safe)
    assert ("safe" in result.model_fields_set) is (safe is not _OMITTED)
    assert result.data == {"answer": "value"}


@pytest.mark.asyncio
@pytest.mark.parametrize("safe", [_OMITTED, None, False, True], ids=["omitted", "synthetic-null", "false", "true"])
@pytest.mark.parametrize("method", ["get_agent_status", "agent"])
async def test_async_agent_status_preserves_safe(method, safe):
    client = AsyncFirecrawlClient.__new__(AsyncFirecrawlClient)
    client.async_http_client = _AsyncTransport(status_safe=safe)
    result = await client.get_agent_status("agent-1") if method == "get_agent_status" else await client.agent(prompt="p")
    assert result.safe is (None if safe is _OMITTED else safe)
    assert ("safe" in result.model_fields_set) is (safe is not _OMITTED)
    assert result.data == {"answer": "value"}


@pytest.mark.parametrize("safe", [_OMITTED, None, True, False], ids=["omitted", "synthetic-null", "true", "synthetic-false"])
def test_sync_agent_list_options_preserve_safe(safe):
    client = FirecrawlClient.__new__(FirecrawlClient)
    client.http_client = _SyncTransport(list_safe=safe)
    options = client.list_agents().agents[0].options
    assert options.safe is (None if safe is _OMITTED else safe)
    assert ("safe" in options.model_fields_set) is (safe is not _OMITTED)
    assert options.prompt == "p"


@pytest.mark.parametrize("safe", [_OMITTED, None, True, False], ids=["omitted", "synthetic-null", "true", "synthetic-false"])
def test_agent_list_model_preserves_safe_independently_of_async_http(safe):
    # The existing async list method uses httpx.Response.ok (#4787); validate
    # the shared response model separately without claiming that method works.
    options = AgentListResponse.model_validate(_list_payload(safe)).agents[0].options
    assert options.safe is (None if safe is _OMITTED else safe)
    assert ("safe" in options.model_fields_set) is (safe is not _OMITTED)


def test_optional_status_safe_serialization_distinguishes_omitted_and_false():
    omitted = AgentResponse.model_validate({"success": True})
    explicit_false = AgentResponse.model_validate({"success": True, "safe": False})
    assert omitted.safe is None
    assert "safe" not in omitted.model_dump(exclude_unset=True)
    assert explicit_false.safe is False
    assert explicit_false.model_dump(exclude_unset=True)["safe"] is False
    assert omitted.model_dump()["safe"] is None
    assert "safe" not in omitted.model_dump(exclude_none=True)
    explicit_null = AgentResponse.model_validate({"success": True, "safe": None})
    assert "safe" in explicit_null.model_fields_set
    assert explicit_null.model_dump(exclude_unset=True)["safe"] is None
    assert "safe" not in explicit_null.model_dump(exclude_none=True)


@pytest.mark.parametrize("safe", [_OMITTED, False, True], ids=["omitted", "false", "true"])
def test_agent_thread_existing_extra_preservation_is_unchanged(safe):
    payload = {"id": "run-1", "status": "succeeded"}
    if safe is not _OMITTED:
        payload["safe"] = safe
    result = AgentThreadRun.model_validate(payload)
    if safe is _OMITTED:
        assert not hasattr(result, "safe")
        assert "safe" not in result.model_dump(exclude_unset=True)
    else:
        assert result.safe is safe
        assert result.model_dump(exclude_unset=True)["safe"] is safe


@pytest.mark.parametrize("safe,expected", [("true", True), ("false", False)])
def test_typed_response_safe_uses_pydantic_boolean_coercion(safe, expected):
    # Compatibility: server promises a boolean, but Pydantic v2 normally
    # accepts these strings for declared bool fields.
    assert AgentResponse.model_validate({"safe": safe}).safe is expected
    assert AgentListResponse.model_validate(_list_payload(safe)).agents[0].options.safe is expected


def test_typed_response_rejects_unparseable_safe_value():
    # This is an observable change from ignoring the formerly unknown key.
    with pytest.raises(ValidationError):
        AgentResponse.model_validate({"safe": "not-a-boolean"})
    with pytest.raises(ValidationError):
        AgentListResponse.model_validate(_list_payload("not-a-boolean"))
