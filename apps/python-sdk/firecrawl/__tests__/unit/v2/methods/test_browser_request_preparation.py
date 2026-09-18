from unittest.mock import Mock

import pytest

from firecrawl.v2.methods import browser as browser_module
from firecrawl.v2.methods.aio import browser as async_browser_module


def _response():
    response = Mock()
    response.ok = True
    response.json.return_value = {"success": True, "id": "session-id"}
    return response


def test_browser_sends_record_session():
    client = Mock()
    client.post.return_value = _response()

    browser_module.browser(client, record_session=False)

    client.post.assert_called_once_with(
        "/v2/browser", {"recordSession": False}
    )


@pytest.mark.asyncio
async def test_async_browser_sends_record_session():
    client = Mock()
    client.post = Mock(return_value=_response())

    async def post(*args, **kwargs):
        return client.post(*args, **kwargs)

    async_client = Mock()
    async_client.post = post

    await async_browser_module.browser(async_client, record_session=False)

    client.post.assert_called_once_with(
        "/v2/browser", {"recordSession": False}
    )
