import pytest
from firecrawl.v2.types import ScrapeOptions, Location
from firecrawl.v2.methods.aio.scrape import (
    _prepare_scrape_request,
    interact,
    stop_interaction,
)


class _FakeAsyncResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload

    @property
    def text(self):
        return str(self._payload)


class _FakeAsyncClient:
    def __init__(
        self,
        *,
        post_response: _FakeAsyncResponse,
        delete_response: _FakeAsyncResponse,
    ):
        self.post_response = post_response
        self.delete_response = delete_response
        self.last_post = None
        self.last_delete = None

    async def post(self, endpoint, payload):
        self.last_post = (endpoint, payload)
        return self.post_response

    async def delete(self, endpoint):
        self.last_delete = endpoint
        return self.delete_response


class TestAsyncScrapeRequestPreparation:
    @pytest.mark.asyncio
    async def test_basic_request_preparation(self):
        payload = await _prepare_scrape_request("https://example.com", None)
        assert payload["url"] == "https://example.com"

    @pytest.mark.asyncio
    async def test_options_conversion(self):
        opts = ScrapeOptions(
            formats=["markdown", {"type": "screenshot", "full_page": True, "quality": 80}],
            include_tags=["main"],
            exclude_tags=["nav"],
            only_main_content=True,
            wait_for=500,
            timeout=30000,
            mobile=True,
            parsers=["pdf"],
            location=Location(country="us", languages=["en"]),
            skip_tls_verification=False,
            remove_base64_images=False,
            fast_mode=True,
            use_mock="test",
            block_ads=False,
            proxy="basic",
            max_age=1000,
            store_in_cache=False,
            lockdown=True,
        )
        payload = await _prepare_scrape_request("https://example.com", opts)
        assert payload["url"] == "https://example.com"
        assert isinstance(payload.get("formats"), list) and "markdown" in payload["formats"]
        assert payload["includeTags"] == ["main"]
        assert payload["excludeTags"] == ["nav"]
        assert payload["onlyMainContent"] is True
        assert payload["waitFor"] == 500
        assert payload["timeout"] == 30000
        assert payload["mobile"] is True
        assert payload["skipTlsVerification"] is False
        assert payload["removeBase64Images"] is False
        assert payload["fastMode"] is True
        assert payload["useMock"] == "test"
        assert payload["blockAds"] is False
        assert payload["proxy"] == "basic"
        assert payload["maxAge"] == 1000
        assert payload["storeInCache"] is False
        assert payload["lockdown"] is True

    @pytest.mark.asyncio
    async def test_interact_request_and_response_normalization(self):
        client = _FakeAsyncClient(
            post_response=_FakeAsyncResponse(
                200,
                {
                    "success": True,
                    "stdout": "ok",
                    "exitCode": 0,
                },
            ),
            delete_response=_FakeAsyncResponse(200, {"success": True}),
        )
        response = await interact(
            client,
            "job-123",
            "console.log('ok')",
            timeout=30,
            origin="_unit-test",
        )

        assert client.last_post[0] == "/v2/scrape/job-123/interact"
        assert client.last_post[1] == {
            "code": "console.log('ok')",
            "language": "node",
            "timeout": 30,
            "origin": "_unit-test",
        }
        assert response.success is True
        assert response.exit_code == 0

    @pytest.mark.asyncio
    async def test_interact_with_prompt(self):
        client = _FakeAsyncClient(
            post_response=_FakeAsyncResponse(
                200,
                {
                    "success": True,
                    "output": "Clicked the button",
                    "cdpUrl": "wss://browser.example.com/cdp",
                    "liveViewUrl": "https://live.example.com/view",
                    "interactiveLiveViewUrl": "https://live.example.com/interactive",
                    "stdout": "",
                    "exitCode": 0,
                },
            ),
            delete_response=_FakeAsyncResponse(200, {"success": True}),
        )
        response = await interact(
            client,
            "job-456",
            prompt="Click the login button",
        )

        assert client.last_post[0] == "/v2/scrape/job-456/interact"
        assert client.last_post[1] == {
            "language": "node",
            "prompt": "Click the login button",
        }
        assert response.success is True
        assert response.output == "Clicked the button"
        assert response.cdp_url == "wss://browser.example.com/cdp"
        assert response.live_view_url == "https://live.example.com/view"
        assert response.interactive_live_view_url == "https://live.example.com/interactive"

    @pytest.mark.asyncio
    async def test_interact_validates_required_inputs(self):
        client = _FakeAsyncClient(
            post_response=_FakeAsyncResponse(200, {"success": True}),
            delete_response=_FakeAsyncResponse(200, {"success": True}),
        )
        with pytest.raises(ValueError, match="Job ID cannot be empty"):
            await interact(client, "", "console.log('ok')")
        with pytest.raises(ValueError, match="Either 'code' or 'prompt' must be provided"):
            await interact(client, "job-123")

    @pytest.mark.asyncio
    async def test_interact_raises_when_success_false(self):
        client = _FakeAsyncClient(
            post_response=_FakeAsyncResponse(
                200,
                {
                    "success": False,
                    "error": "Replay context is unavailable",
                },
            ),
            delete_response=_FakeAsyncResponse(200, {"success": True}),
        )
        with pytest.raises(Exception, match="Replay context is unavailable"):
            await interact(client, "job-123", "console.log('ok')")

    @pytest.mark.asyncio
    async def test_stop_interaction_request_and_response_normalization(self):
        client = _FakeAsyncClient(
            post_response=_FakeAsyncResponse(200, {"success": True}),
            delete_response=_FakeAsyncResponse(
                200,
                {
                    "success": True,
                    "sessionDurationMs": 900,
                    "creditsBilled": 2,
                },
            ),
        )
        response = await stop_interaction(client, "job-123")

        assert client.last_delete == "/v2/scrape/job-123/interact"
        assert response.success is True
        assert response.session_duration_ms == 900
        assert response.credits_billed == 2

