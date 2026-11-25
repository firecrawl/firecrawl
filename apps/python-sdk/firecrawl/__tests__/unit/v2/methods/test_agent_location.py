import pytest

from firecrawl.v2.methods.agent import _prepare_agent_request, start_agent
from firecrawl.v2.methods.aio import agent as async_agent


class _FakeResponse:
    ok = True
    status_code = 200

    def json(self):
        return {"success": True, "id": "agent-1"}


class _FakeClient:
    def __init__(self):
        self.last_post = None

    def post(self, endpoint, payload):
        self.last_post = (endpoint, payload)
        return _FakeResponse()


class _FakeAsyncClient(_FakeClient):
    async def post(self, endpoint, payload):
        return super().post(endpoint, payload)


def test_prepare_includes_location():
    data = _prepare_agent_request(None, prompt="p", location={"country": "DE"})
    assert data["location"] == {"country": "DE"}


def test_prepare_omits_location_by_default():
    data = _prepare_agent_request(None, prompt="p")
    assert "location" not in data


def test_start_agent_sends_location():
    client = _FakeClient()
    start_agent(client, None, prompt="p", location={"country": "DE"})
    assert client.last_post == (
        "/v2/agent",
        {"prompt": "p", "location": {"country": "DE"}},
    )


@pytest.mark.asyncio
async def test_async_start_agent_sends_location():
    client = _FakeAsyncClient()
    await async_agent.start_agent(client, None, prompt="p", location={"country": "DE"})
    assert client.last_post == (
        "/v2/agent",
        {"prompt": "p", "location": {"country": "DE"}},
    )
