"""Async mirror of test_browser_record_session: public async facade -> real
HTTP serialization -> in-memory MockTransport."""
import asyncio
import json

import httpx
import pytest
from firecrawl.v2.client_async import AsyncFirecrawlClient


@pytest.mark.parametrize("case", ["false", "true", "none", "omitted"])
def test_async_browser_recording_payload(case):
    async def run():
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(200, json={"success": True, "id": "test-session"})

        client = AsyncFirecrawlClient(api_key="dummy-test-key", max_retries=1)
        await client.async_http_client.close()
        client.async_http_client._client = httpx.AsyncClient(
            base_url="https://example.test", transport=httpx.MockTransport(handler)
        )
        try:
            if case == "omitted":
                result = await client.browser(
                    ttl=600, activity_ttl=120, stream_web_view=False,
                    profile={"name": "test-profile", "save_changes": False},
                )
            else:
                result = await client.browser(
                    record_session={"false": False, "true": True, "none": None}[case],
                    ttl=600, activity_ttl=120, stream_web_view=False,
                    profile={"name": "test-profile", "save_changes": False},
                )
        finally:
            await client.async_http_client.close()
        assert result.id == "test-session"
        assert len(requests) == 1
        assert requests[0].method == "POST"
        assert requests[0].url.path == "/v2/browser"
        payload = json.loads(requests[0].content)
        expected = {"ttl": 600, "activityTtl": 120, "streamWebView": False,
                    "profile": {"name": "test-profile", "saveChanges": False}}
        if case in ("false", "true"):
            expected["recordSession"] = case == "true"
            assert payload["recordSession"] is expected["recordSession"]
        else:
            assert "recordSession" not in payload
        assert payload.pop("origin").startswith("python-sdk@")
        assert payload == expected

    asyncio.run(run())
