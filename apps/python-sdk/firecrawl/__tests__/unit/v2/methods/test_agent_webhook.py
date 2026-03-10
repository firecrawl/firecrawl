"""Unit tests for AgentWebhookConfig."""

import pytest
from firecrawl.v2.types import AgentWebhookConfig


class TestAgentWebhookConfig:
    """Test AgentWebhookConfig class functionality."""

    def test_minimal_config(self):
        """Test creating config with only URL."""
        config = AgentWebhookConfig(url="https://example.com/webhook")
        assert config.url == "https://example.com/webhook"
        assert config.headers is None
        assert config.metadata is None
        assert config.events is None

    def test_full_config(self):
        """Test creating config with all fields."""
        config = AgentWebhookConfig(
            url="https://example.com/webhook",
            headers={"Authorization": "Bearer token"},
            metadata={"project": "test"},
            events=["started", "action", "completed"]
        )
        assert config.url == "https://example.com/webhook"
        assert config.headers == {"Authorization": "Bearer token"}
        assert config.metadata == {"project": "test"}
        assert config.events == ["started", "action", "completed"]

    def test_url_required(self):
        """Test that URL is required."""
        with pytest.raises(Exception):
            AgentWebhookConfig()

    def test_serialization_excludes_none(self):
        """Test model_dump excludes None values."""
        config = AgentWebhookConfig(url="https://example.com/webhook")
        data = config.model_dump(exclude_none=True)
        assert data == {"url": "https://example.com/webhook"}

    def test_serialization_includes_all_fields(self):
        """Test model_dump includes all non-None fields."""
        config = AgentWebhookConfig(
            url="https://example.com/webhook",
            headers={"X-Custom": "value"},
            events=["completed", "failed"]
        )
        data = config.model_dump(exclude_none=True)
        assert data == {
            "url": "https://example.com/webhook",
            "headers": {"X-Custom": "value"},
            "events": ["completed", "failed"]
        }

    def test_agent_specific_events(self):
        """Test that agent-specific events are valid."""
        config = AgentWebhookConfig(
            url="https://example.com/webhook",
            events=["started", "action", "completed", "failed", "cancelled"]
        )
        assert "action" in config.events
        assert "cancelled" in config.events

    def test_single_event(self):
        """Test config with single event."""
        config = AgentWebhookConfig(
            url="https://example.com/webhook",
            events=["completed"]
        )
        assert config.events == ["completed"]

    def test_empty_headers(self):
        """Test config with empty headers dict."""
        config = AgentWebhookConfig(
            url="https://example.com/webhook",
            headers={}
        )
        assert config.headers == {}

    def test_multiple_headers(self):
        """Test config with multiple headers."""
        config = AgentWebhookConfig(
            url="https://example.com/webhook",
            headers={
                "Authorization": "Bearer token",
                "X-Custom-Header": "value",
                "Content-Type": "application/json"
            }
        )
        assert len(config.headers) == 3
        assert config.headers["Authorization"] == "Bearer token"
