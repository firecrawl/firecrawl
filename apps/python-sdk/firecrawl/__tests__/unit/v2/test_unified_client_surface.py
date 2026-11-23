"""The AsyncFirecrawl facade must expose the same v2 methods as Firecrawl.

Both facades bind one attribute per v2 client method by hand, so a method can be
added to the sync facade and missed in the async one, where it then raises
AttributeError even though the async v2 client provides it.
"""

import asyncio

from firecrawl import AsyncFirecrawl, Firecrawl


def _surface(client: object) -> set[str]:
    bound = {name for name in vars(client) if not name.startswith("_")}
    methods = {
        name
        for name, value in vars(type(client)).items()
        if not name.startswith("_") and callable(value)
    }
    return bound | methods


def test_async_facade_exposes_every_sync_facade_method() -> None:
    async_client = AsyncFirecrawl(api_key="fc-test")
    try:
        sync_surface = _surface(Firecrawl(api_key="fc-test"))
        missing = sorted(sync_surface - _surface(async_client))
        exposed = async_client.get_active_crawls
    finally:
        asyncio.run(async_client._v2_client.async_http_client.close())

    assert missing == []
    assert exposed == async_client._v2_client.get_active_crawls
