"""
Unit tests for agent request preparation.
"""

import pytest  # type: ignore[import-not-found]
from pydantic import BaseModel, Field  # type: ignore[import-not-found]
from typing import List, Optional

from firecrawl.v2.methods.agent import _prepare_agent_request
from firecrawl.v2.types import AgentWebhookConfig


class TestAgentRequestPreparation:
    """Unit tests for agent request preparation."""

    def test_basic_request_preparation(self):
        """Test basic request preparation with minimal fields."""
        data = _prepare_agent_request(
            None,
            prompt="Find information about Firecrawl"
        )
        
        assert data["prompt"] == "Find information about Firecrawl"
        assert "urls" not in data
        assert "schema" not in data

    def test_request_with_urls(self):
        """Test request preparation with URLs."""
        urls = ["https://example.com", "https://test.com"]
        data = _prepare_agent_request(
            urls,
            prompt="Extract data from these pages"
        )
        
        assert data["prompt"] == "Extract data from these pages"
        assert data["urls"] == urls

    def test_request_with_dict_schema(self):
        """Test request preparation with dict schema."""
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"}
            }
        }
        data = _prepare_agent_request(
            None,
            prompt="Extract person data",
            schema=schema
        )
        
        assert data["prompt"] == "Extract person data"
        assert data["schema"] == schema

    def test_request_with_pydantic_schema(self):
        """Test request preparation with Pydantic BaseModel schema."""
        class Person(BaseModel):
            name: str = Field(description="Person's name")
            age: Optional[int] = Field(None, description="Person's age")
        
        data = _prepare_agent_request(
            None,
            prompt="Extract person data",
            schema=Person
        )
        
        assert data["prompt"] == "Extract person data"
        assert "schema" in data
        assert data["schema"]["type"] == "object"
        assert "properties" in data["schema"]
        assert "name" in data["schema"]["properties"]
        assert "age" in data["schema"]["properties"]

    def test_request_with_pydantic_schema_instance(self):
        """Test request preparation with Pydantic model instance."""
        class Person(BaseModel):
            name: str = Field(description="Person's name")
            age: Optional[int] = Field(None, description="Person's age")
        
        person_instance = Person(name="John", age=30)
        data = _prepare_agent_request(
            None,
            prompt="Extract person data",
            schema=person_instance
        )
        
        assert data["prompt"] == "Extract person data"
        assert "schema" in data
        # Should use the class schema, not the instance data
        assert data["schema"]["type"] == "object"

    def test_request_with_nested_pydantic_schema(self):
        """Test request preparation with nested Pydantic schema."""
        class Founder(BaseModel):
            name: str = Field(description="Full name of the founder")
            role: Optional[str] = Field(None, description="Role or position")
        
        class FoundersSchema(BaseModel):
            founders: List[Founder] = Field(description="List of founders")
        
        data = _prepare_agent_request(
            None,
            prompt="Find the founders",
            schema=FoundersSchema
        )
        
        assert data["prompt"] == "Find the founders"
        assert "schema" in data
        assert data["schema"]["type"] == "object"
        assert "founders" in data["schema"]["properties"]
        assert data["schema"]["properties"]["founders"]["type"] == "array"

    def test_request_with_integration(self):
        """Test request preparation with integration tag."""
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            integration="  test-integration  "
        )
        
        assert data["prompt"] == "Test prompt"
        assert data["integration"] == "test-integration"

    def test_request_with_max_credits(self):
        """Test request preparation with max credits."""
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            max_credits=100
        )
        
        assert data["prompt"] == "Test prompt"
        assert data["maxCredits"] == 100

    def test_request_with_zero_data_retention(self):
        """Test request preparation with zero data retention."""
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            zero_data_retention=True
        )

        assert data["prompt"] == "Test prompt"
        assert data["zeroDataRetention"] is True

    def test_request_with_strict_constrain_to_urls(self):
        """Test request preparation with strict_constrain_to_urls."""
        data = _prepare_agent_request(
            ["https://example.com"],
            prompt="Test prompt",
            strict_constrain_to_urls=True
        )
        
        assert data["prompt"] == "Test prompt"
        assert data["strictConstrainToURLs"] is True

    def test_request_all_fields(self):
        """Test request preparation with all fields."""
        schema = {
            "type": "object",
            "properties": {"test": {"type": "string"}}
        }
        urls = ["https://example.com"]
        
        data = _prepare_agent_request(
            urls,
            prompt="Complete test",
            schema=schema,
            integration="test-integration",
            max_credits=50,
            zero_data_retention=True,
            strict_constrain_to_urls=True
        )
        
        assert data["prompt"] == "Complete test"
        assert data["urls"] == urls
        assert data["schema"] == schema
        assert data["integration"] == "test-integration"
        assert data["maxCredits"] == 50
        assert data["zeroDataRetention"] is True
        assert data["strictConstrainToURLs"] is True

    def test_request_with_empty_integration(self):
        """Test that empty integration is not included."""
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            integration="   "
        )
        
        assert "integration" not in data

    def test_request_with_zero_max_credits(self):
        """Test that zero max_credits is not included."""
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            max_credits=0
        )
        
        assert "maxCredits" not in data

    def test_request_with_false_strict_constrain(self):
        """Test that False strict_constrain_to_urls is not included."""
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            strict_constrain_to_urls=False
        )
        
        assert "strictConstrainToURLs" not in data

    def test_request_with_invalid_schema_type_string(self):
        """Test that invalid schema types raise ValueError."""
        with pytest.raises(ValueError, match="Invalid schema type"):
            _prepare_agent_request(
                None,
                prompt="Test prompt",
                schema="invalid_string_schema"
            )

    def test_request_with_invalid_schema_type_int(self):
        """Test that invalid schema types raise ValueError."""
        with pytest.raises(ValueError, match="Invalid schema type"):
            _prepare_agent_request(
                None,
                prompt="Test prompt",
                schema=123
            )

    def test_request_with_invalid_schema_type_list(self):
        """Test that invalid schema types raise ValueError."""
        with pytest.raises(ValueError, match="Invalid schema type"):
            _prepare_agent_request(
                None,
                prompt="Test prompt",
                schema=["not", "a", "valid", "schema"]
            )

    def test_request_with_string_webhook(self):
        """Test request preparation with string webhook URL."""
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            webhook="https://example.com/webhook"
        )

        assert data["webhook"] == "https://example.com/webhook"

    def test_request_with_webhook_config(self):
        """Test request preparation with AgentWebhookConfig object."""
        webhook_config = AgentWebhookConfig(
            url="https://example.com/webhook",
            headers={"Authorization": "Bearer token"},
            events=["completed", "failed"]
        )
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            webhook=webhook_config
        )

        assert data["webhook"]["url"] == "https://example.com/webhook"
        assert data["webhook"]["headers"] == {"Authorization": "Bearer token"}
        assert data["webhook"]["events"] == ["completed", "failed"]

    def test_request_without_webhook(self):
        """Test that webhook is not included when None."""
        data = _prepare_agent_request(
            None,
            prompt="Test prompt"
        )

        assert "webhook" not in data

    def test_webhook_config_excludes_none_values(self):
        """Test that None values are excluded from webhook config."""
        webhook_config = AgentWebhookConfig(
            url="https://example.com/webhook"
        )
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            webhook=webhook_config
        )

        assert "headers" not in data["webhook"]
        assert "metadata" not in data["webhook"]
        assert "events" not in data["webhook"]

    def test_agent_specific_webhook_events(self):
        """Test that agent-specific events (action, cancelled) are accepted."""
        webhook_config = AgentWebhookConfig(
            url="https://example.com/webhook",
            events=["started", "action", "completed", "failed", "cancelled"]
        )
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            webhook=webhook_config
        )

        assert "action" in data["webhook"]["events"]
        assert "cancelled" in data["webhook"]["events"]

    def test_webhook_with_metadata(self):
        """Test webhook config with metadata."""
        webhook_config = AgentWebhookConfig(
            url="https://example.com/webhook",
            metadata={"project": "test", "env": "staging"}
        )
        data = _prepare_agent_request(
            None,
            prompt="Test prompt",
            webhook=webhook_config
        )

        assert data["webhook"]["metadata"] == {"project": "test", "env": "staging"}

    def test_request_all_fields_with_webhook(self):
        """Test request preparation with all fields including webhook."""
        schema = {
            "type": "object",
            "properties": {"test": {"type": "string"}}
        }
        urls = ["https://example.com"]
        webhook_config = AgentWebhookConfig(
            url="https://example.com/webhook",
            events=["completed"]
        )

        data = _prepare_agent_request(
            urls,
            prompt="Complete test",
            schema=schema,
            integration="test-integration",
            max_credits=50,
            strict_constrain_to_urls=True,
            model="spark-1-pro",
            webhook=webhook_config
        )

        assert data["prompt"] == "Complete test"
        assert data["urls"] == urls
        assert data["schema"] == schema
        assert data["integration"] == "test-integration"
        assert data["maxCredits"] == 50
        assert data["strictConstrainToURLs"] is True
        assert data["model"] == "spark-1-pro"
        assert data["webhook"]["url"] == "https://example.com/webhook"
