from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from firecrawl.v2.methods.aio import agent as aio_agent
from firecrawl.v2.utils.error_handler import BadRequestError


AGENT_CALLS = [
    (aio_agent.start_agent, "post", (None,), {"prompt": "Find a page"}),
    (aio_agent.get_agent_status, "get", ("job-id",), {}),
    (aio_agent.list_agents, "get", (), {}),
    (aio_agent.get_agent_trace, "get", ("job-id",), {}),
    (aio_agent.get_agent_thread, "get", ("thread-id",), {}),
    (aio_agent.get_agent_snapshot, "get", ("job-id", "snapshot-id"), {}),
    (aio_agent.cancel_agent, "delete", ("job-id",), {}),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("method,verb,args,kwargs", AGENT_CALLS)
async def test_agent_methods_accept_successful_httpx_responses(method, verb, args, kwargs):
    client = Mock()
    setattr(
        client,
        verb,
        AsyncMock(return_value=httpx.Response(200, json={"success": True})),
    )

    result = await method(client, *args, **kwargs)

    if method is aio_agent.cancel_agent:
        assert result is True
    else:
        assert result.success is True


@pytest.mark.asyncio
@pytest.mark.parametrize("method,verb,args,kwargs", AGENT_CALLS)
async def test_agent_methods_raise_api_error_for_httpx_failure(method, verb, args, kwargs):
    client = Mock()
    setattr(
        client,
        verb,
        AsyncMock(return_value=httpx.Response(400, json={"error": "Invalid request"})),
    )

    with pytest.raises(BadRequestError):
        await method(client, *args, **kwargs)
