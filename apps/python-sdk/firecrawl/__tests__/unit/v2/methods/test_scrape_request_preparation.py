import pytest
from firecrawl.v2.types import ScrapeOptions, Viewport, ScreenshotAction
from firecrawl.v2.methods.scrape import (
    _prepare_scrape_request,
    interact,
    stop_interaction,
)


class _FakeResponse:
    def __init__(self, status_code: int, payload):
        self.status_code = status_code
        self._payload = payload
        self.ok = status_code < 400

    def json(self):
        return self._payload

    @property
    def text(self):
        return str(self._payload)


class _FakeClient:
    def __init__(self, *, post_response: _FakeResponse, delete_response: _FakeResponse):
        self.post_response = post_response
        self.delete_response = delete_response
        self.last_post = None
        self.last_delete = None

    def post(self, endpoint, payload):
        self.last_post = (endpoint, payload)
        return self.post_response

    def delete(self, endpoint):
        self.last_delete = endpoint
        return self.delete_response


class TestScrapeRequestPreparation:
    """Unit tests for scrape request preparation."""

    def test_basic_request_preparation(self):
        """Test basic request preparation with minimal fields."""
        data = _prepare_scrape_request("https://example.com")
        
        # Check basic fields
        assert data["url"] == "https://example.com"
        
        # Check that no options are present
        assert "formats" not in data
        assert "headers" not in data

    def test_scrape_options_conversion(self):
        """Test that ScrapeOptions fields are converted to camelCase."""
        options = ScrapeOptions(
            formats=["markdown", "html"],
            headers={"User-Agent": "Test"},
            include_tags=["h1", "h2"],
            exclude_tags=["nav"],
            only_main_content=False,
            timeout=15000,
            wait_for=2000,
            mobile=True,
            skip_tls_verification=True,
            remove_base64_images=False
        )
        
        data = _prepare_scrape_request("https://example.com", options)
        
        # Check basic field
        assert data["url"] == "https://example.com"
        
        # Check snake_case to camelCase conversions
        assert "includeTags" in data
        assert data["includeTags"] == ["h1", "h2"]
        assert "excludeTags" in data
        assert data["excludeTags"] == ["nav"]
        assert "onlyMainContent" in data
        assert data["onlyMainContent"] is False
        assert "waitFor" in data
        assert data["waitFor"] == 2000
        assert "skipTlsVerification" in data
        assert data["skipTlsVerification"] is True
        assert "removeBase64Images" in data
        assert data["removeBase64Images"] is False
        
        # Check that snake_case fields are not present
        assert "include_tags" not in data
        assert "exclude_tags" not in data
        assert "only_main_content" not in data

    def test_actions_conversion(self):
        """Test that actions are converted to camelCase."""
        viewport = Viewport(width=800, height=600)
        action = ScreenshotAction(full_page=False, quality=80, viewport=viewport)
        
        options = ScrapeOptions(actions=[action])
        data = _prepare_scrape_request("https://example.com", options)
        
        assert "actions" in data
        assert len(data["actions"]) == 1
        
        action_data = data["actions"][0]
        assert action_data["type"] == "screenshot"
        assert action_data["fullPage"] is False
        assert action_data["quality"] == 80
        assert "viewport" in action_data

    def test_none_options_handling(self):
        """Test handling of None options."""
        data = _prepare_scrape_request("https://example.com", None)
        
        assert data["url"] == "https://example.com"
        # Should not have any option fields
        assert len(data) == 1

    def test_empty_url_validation(self):
        """Test validation with empty URL."""
        with pytest.raises(ValueError, match="URL cannot be empty"):
            _prepare_scrape_request("")

    def test_whitespace_url_validation(self):
        """Test validation with whitespace-only URL."""
        with pytest.raises(ValueError, match="URL cannot be empty"):
            _prepare_scrape_request("   ")

    def test_all_params_including_integration(self):
        opts = ScrapeOptions(
            formats=["markdown"],
            headers={"User-Agent": "Test"},
            include_tags=["h1"],
            exclude_tags=["nav"],
            only_main_content=False,
            timeout=15000,
            wait_for=2000,
            mobile=True,
            skip_tls_verification=True,
            remove_base64_images=False,
            integration="  _unit-test  ",
        )
        data = _prepare_scrape_request("https://example.com", opts)
        assert data["integration"] == "_unit-test"

    def test_interact_request_and_response_normalization(self):
        client = _FakeClient(
            post_response=_FakeResponse(
                200,
                {
                    "success": True,
                    "stdout": "ok",
                    "exitCode": 0,
                },
            ),
            delete_response=_FakeResponse(200, {"success": True}),
        )
        response = interact(
            client,
            "job-123",
            "console.log('ok')",
            timeout=45,
            origin="_unit-test",
        )

        assert client.last_post[0] == "/v2/scrape/job-123/interact"
        assert client.last_post[1] == {
            "code": "console.log('ok')",
            "language": "node",
            "timeout": 45,
            "origin": "_unit-test",
        }
        assert response.success is True
        assert response.exit_code == 0

    def test_interact_with_prompt(self):
        client = _FakeClient(
            post_response=_FakeResponse(
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
            delete_response=_FakeResponse(200, {"success": True}),
        )
        response = interact(
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

    def test_interact_validates_required_inputs(self):
        client = _FakeClient(
            post_response=_FakeResponse(200, {"success": True}),
            delete_response=_FakeResponse(200, {"success": True}),
        )
        with pytest.raises(ValueError, match="Job ID cannot be empty"):
            interact(client, "", "console.log('ok')")
        with pytest.raises(ValueError, match="Either 'code' or 'prompt' must be provided"):
            interact(client, "job-123")

    def test_interact_raises_when_success_false(self):
        client = _FakeClient(
            post_response=_FakeResponse(
                200,
                {
                    "success": False,
                    "error": "Replay context is unavailable",
                },
            ),
            delete_response=_FakeResponse(200, {"success": True}),
        )

        with pytest.raises(Exception, match="Replay context is unavailable"):
            interact(client, "job-123", "console.log('ok')")

    def test_stop_interaction_request_and_response_normalization(self):
        client = _FakeClient(
            post_response=_FakeResponse(200, {"success": True}),
            delete_response=_FakeResponse(
                200,
                {
                    "success": True,
                    "sessionDurationMs": 1200,
                    "creditsBilled": 3,
                },
            ),
        )
        response = stop_interaction(client, "job-123")

        assert client.last_delete == "/v2/scrape/job-123/interact"
        assert response.success is True
        assert response.session_duration_ms == 1200
        assert response.credits_billed == 3