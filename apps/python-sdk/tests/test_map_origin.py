"""Tests for forwarding the `origin` attribution tag on map().

The API accepts `origin` on /v2/map and the JS SDK forwards it, but the
Python SDK used to drop it: MapOptions had no `origin` field and neither
the sync/async payload builders nor the client wrappers sent it.
"""

import asyncio
import inspect

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.types import MapOptions
import firecrawl.v2.methods.map as map_mod
from firecrawl.v2.methods.aio import map as async_map_mod


@pytest.fixture
def client():
    return FirecrawlClient(api_key="test-key", api_url="http://localhost:9")


@pytest.fixture
def async_client():
    return AsyncFirecrawlClient(api_key="test-key", api_url="http://localhost:9")


class TestMapOrigin:
    def test_map_options_accepts_origin(self):
        assert MapOptions(origin="my-wrapper").origin == "my-wrapper"
        assert MapOptions().origin is None

    def test_sync_prepare_includes_origin(self):
        payload = map_mod._prepare_map_request(
            "https://example.com", MapOptions(origin="my-wrapper")
        )
        assert payload["origin"] == "my-wrapper"

    def test_sync_prepare_trims_origin(self):
        payload = map_mod._prepare_map_request(
            "https://example.com", MapOptions(origin="  my-wrapper  ")
        )
        assert payload["origin"] == "my-wrapper"

    def test_sync_prepare_omits_origin_when_none(self):
        payload = map_mod._prepare_map_request(
            "https://example.com", MapOptions()
        )
        assert "origin" not in payload

    def test_async_prepare_includes_origin(self):
        payload = async_map_mod._prepare_map_request(
            "https://example.com", MapOptions(origin="my-wrapper")
        )
        assert payload["origin"] == "my-wrapper"

    def test_async_prepare_omits_origin_when_none(self):
        payload = async_map_mod._prepare_map_request(
            "https://example.com", MapOptions()
        )
        assert "origin" not in payload

    def test_client_map_signature_accepts_origin(self):
        assert "origin" in inspect.signature(FirecrawlClient.map).parameters

    def test_async_client_map_signature_accepts_origin(self):
        assert "origin" in inspect.signature(AsyncFirecrawlClient.map).parameters

    def test_client_map_forwards_origin(self, client, monkeypatch):
        captured = {}

        def fake_map(http, url, options):
            captured["options"] = options
            raise ConnectionError("captured")

        monkeypatch.setattr(map_mod, "map", fake_map)

        with pytest.raises(ConnectionError):
            client.map("https://example.com", origin="my-wrapper")

        assert captured["options"] is not None
        assert captured["options"].origin == "my-wrapper"

    def test_async_client_map_forwards_origin(self, async_client, monkeypatch):
        captured = {}

        async def fake_map(http, url, options):
            captured["options"] = options
            raise ConnectionError("captured")

        monkeypatch.setattr(async_map_mod, "map", fake_map)

        with pytest.raises(ConnectionError):
            asyncio.get_event_loop().run_until_complete(
                async_client.map("https://example.com", origin="my-wrapper")
            )

        assert captured["options"] is not None
        assert captured["options"].origin == "my-wrapper"
