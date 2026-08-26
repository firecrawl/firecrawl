"""
Unit tests for agent request preparation.
"""

import pytest
from pydantic import BaseModel, Field
from typing import List, Optional

from firecrawl.v2.methods.agent import _prepare_agent_request
from firecrawl.v2.types import AgentResponse, AgentWebhookConfig


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
            strict_constrain_to_urls=True
        )
        
        assert data["prompt"] == "Complete test"
        assert data["urls"] == urls
        assert data["schema"] == schema
        assert data["integration"] == "test-integration"
        assert data["maxCredits"] == 50
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

    @pytest.mark.parametrize("model", ["spark-2", "spark-1-pro", "spark-1-mini"])
    def test_model_forwarded_verbatim(self, model):
        """Every documented model, including spark-2, reaches the request body."""
        data = _prepare_agent_request(None, prompt="Model test", model=model)

        assert data["model"] == model


class TestAgentResponseParsing:
    """Unit tests for parsing agent status payloads."""

    @pytest.mark.parametrize("model", ["spark-2", "spark-1-pro", "spark-1-mini"])
    def test_status_payload_parses_known_models(self, model):
        """A status payload naming any current model parses.

        /v2/agent/:id always returns `model`, and it defaults to spark-1-pro, so a
        narrow type here breaks every poll of a default-model job.
        """
        response = AgentResponse(
            **{"success": True, "id": "job-1", "status": "completed", "model": model}
        )

        assert response.model == model

    def test_status_payload_parses_unreleased_model(self):
        """An unknown model name must not raise; the server ships models first."""
        response = AgentResponse(
            **{"success": True, "id": "job-1", "status": "completed", "model": "spark-3"}
        )

        assert response.model == "spark-3"


class TestAgentEffort:
    """Unit tests for the agent effort parameter."""

    @pytest.mark.parametrize("effort", ["low", "medium", "high"])
    def test_effort_forwarded_verbatim(self, effort):
        """Every documented effort level reaches the request body."""
        data = _prepare_agent_request(None, prompt="Effort test", effort=effort)

        assert data["effort"] == effort

    def test_effort_omitted_when_unset(self):
        data = _prepare_agent_request(None, prompt="Effort test")

        assert "effort" not in data

    def test_status_payload_parses_effort(self):
        """The status response carries the effort the run used."""
        response = AgentResponse(
            **{
                "success": True,
                "id": "job-1",
                "status": "completed",
                "model": "spark-2",
                "effort": "high",
            }
        )

        assert response.effort == "high"


class TestAgentTraceAndSnapshotParsing:
    """Unit tests for parsing agent trace and snapshot payloads."""

    BASE_EVENT = {
        "schemaVersion": 1,
        "eventId": "018f3c5e-0000-7000-8000-000000000000",
        "runId": "018f3c5e-0000-7000-8000-000000000001",
        "occurredAt": "2026-08-26T12:00:00+00:00",
        "producerSequence": 1,
        "agent": {
            "id": "018f3c5e-0000-7000-8000-000000000002",
            "role": "orchestrator",
            "name": "main",
        },
    }

    def test_trace_parses_representative_events(self):
        from firecrawl.v2.types import AgentTraceResponse

        events = [
            {"type": "run.started"},
            {"type": "run.cancel_requested", "reason": "user"},
            {
                "type": "run.finished",
                "outcome": "credit_limit_reached",
                "error": {
                    "code": "credit_limit_reached",
                    "source": "billing",
                    "retryable": False,
                    "message": "out of credits",
                },
            },
            {"type": "agent.started"},
            {
                "type": "agent.finished",
                "outcome": "succeeded",
                "durationMs": 1234,
                "error": None,
            },
            {"type": "browser.session.started", "sessionId": "sess-1"},
            {"type": "browser.session.finished", "sessionId": "sess-1", "durationMs": 42},
            {"type": "progress.reported", "phase": "working", "message": "reading"},
            {"type": "reasoning.summary", "text": "thinking"},
            {
                "type": "tool_call.started",
                "toolCallId": "tc-1",
                "toolName": "scrape",
                "parameters": {"url": "https://example.com"},
            },
            {
                "type": "tool_call.finished",
                "toolCallId": "tc-1",
                "toolName": "scrape",
                "result": {"ok": True},
            },
            {
                "type": "artifact.updated",
                "artifact": {
                    "kind": "json",
                    "artifactId": "result",
                    "path": "/workspace/data.json",
                    "snapshotId": "018f3c5e-0000-7000-8000-000000000003",
                    "change": "partial",
                    "changedFields": ["price"],
                    "itemCount": 3,
                    "sourceToolCallId": "tc-1",
                },
            },
            {
                "type": "error.occurred",
                "error": {
                    "code": "internal",
                    "source": "system",
                    "retryable": True,
                    "message": "boom",
                },
            },
        ]

        response = AgentTraceResponse(
            **{
                "success": True,
                "id": "job-1",
                "events": [{**self.BASE_EVENT, **e} for e in events],
                "creditsUsed": 5,
                "activeBrowserSessions": [
                    {
                        "id": "sess-1",
                        "liveViewUrl": "https://browser.example.com/sess-1",
                        "viewport": {"width": 1280, "height": 720},
                    }
                ],
            }
        )

        assert len(response.events) == 13
        assert response.events[0].type == "run.started"
        assert response.events[4].duration_ms == 1234
        assert response.events[4].error is None
        artifact = response.events[11].artifact
        assert artifact.snapshot_id == "018f3c5e-0000-7000-8000-000000000003"
        assert artifact.change == "partial"
        assert artifact.changed_fields == ["price"]
        assert response.events[12].error.code == "internal"
        assert response.credits_used == 5
        assert response.active_browser_sessions[0].viewport.width == 1280

    def test_snapshot_payload_parses(self):
        from firecrawl.v2.types import AgentSnapshotResponse

        response = AgentSnapshotResponse(
            **{
                "success": True,
                "id": "job-1",
                "snapshotId": "snap-1",
                "snapshot": '{"price": 42}',
            }
        )

        assert response.snapshot_id == "snap-1"
        assert response.snapshot == '{"price": 42}'

    def test_trace_parses_terminal_events_without_error_key(self):
        """Terminal events missing the error key still parse (older rows)."""
        from firecrawl.v2.types import AgentTraceResponse

        events = [
            {"type": "run.finished", "outcome": "succeeded"},
            {"type": "agent.finished", "outcome": "succeeded", "durationMs": 7},
        ]

        response = AgentTraceResponse(
            **{
                "success": True,
                "id": "job-1",
                "events": [{**self.BASE_EVENT, **e} for e in events],
            }
        )

        assert response.events[0].error is None
        assert response.events[1].error is None
