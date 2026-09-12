"""
Unit tests for agent threads: request serialization, status parsing and the
thread read method.
"""

from unittest.mock import Mock

from firecrawl.v2.methods.agent import (
    _prepare_agent_request,
    get_agent_thread,
    start_agent,
)
from firecrawl.v2.types import (
    AgentExchangeOptions,
    AgentResponse,
    AgentThreadResponse,
)


class TestAgentThreadRequestPreparation:
    """The thread fields must only reach the body when the caller sets them."""

    def test_thread_fields_omitted_when_unset(self):
        data = _prepare_agent_request(None, prompt="List the pricing tiers")

        assert "threadId" not in data
        assert "mode" not in data
        assert "exchange" not in data

    def test_thread_id_and_mode_forwarded(self):
        data = _prepare_agent_request(
            None,
            prompt="Which tier has SSO?",
            thread_id="thread-1",
            mode="chat",
        )

        assert data["threadId"] == "thread-1"
        assert data["mode"] == "chat"

    def test_exchange_dict_forwarded_verbatim(self):
        exchange = {"enabled": True, "toolkits": ["a", "b"], "maxCalls": 4}
        data = _prepare_agent_request(
            None, prompt="Which tier has SSO?", exchange=exchange
        )

        assert data["exchange"] == exchange

    def test_exchange_model_serialized_by_alias(self):
        data = _prepare_agent_request(
            None,
            prompt="Which tier has SSO?",
            exchange=AgentExchangeOptions(enabled=True, max_calls=4),
        )

        assert data["exchange"] == {"enabled": True, "maxCalls": 4}

    def test_start_agent_forwards_thread_id(self):
        client = Mock()
        response = Mock()
        response.ok = True
        response.json.return_value = {
            "success": True,
            "id": "job-2",
            "threadId": "thread-1",
            "threadTurn": 2,
        }
        client.post.return_value = response

        result = start_agent(
            client, None, prompt="Which tier has SSO?", thread_id="thread-1"
        )

        assert client.post.call_args[0][1]["threadId"] == "thread-1"
        assert result.thread_id == "thread-1"
        assert result.thread_turn == 2


class TestAgentThreadStatusParsing:
    """Status payloads parse with and without the thread fields."""

    def test_status_payload_without_thread_fields(self):
        response = AgentResponse(
            **{
                "success": True,
                "id": "job-1",
                "status": "completed",
                "model": "spark-2",
                "data": {"price": 42},
            }
        )

        assert response.data == {"price": 42}
        assert response.thread_id is None
        assert response.message is None
        assert response.pending_approval is None

    def test_chat_mode_status_payload(self):
        response = AgentResponse(
            **{
                "success": True,
                "id": "job-2",
                "status": "completed",
                "model": "spark-2",
                "data": None,
                "threadId": "thread-1",
                "threadTurn": 2,
                "mode": "chat",
                "message": "Only the Enterprise tier lists SSO.",
                "suggestions": [
                    {"label": "Seat caps?", "prompt": "Does Team cap seats?"}
                ],
                "pendingApproval": {
                    "id": "approval-1",
                    "reason": "One paid call answers this.",
                    "calls": [
                        {
                            "id": "call-1",
                            "provider": "provider-1",
                            "capability": "capability-1",
                            "input": {"query": "sso"},
                            "creditsEstimate": 5,
                        }
                    ],
                    "resolution": None,
                },
                "exchange": {"enabled": True, "paidCalls": 0, "creditsUsed": None},
            }
        )

        assert response.data is None
        assert response.message == "Only the Enterprise tier lists SSO."
        assert response.mode == "chat"
        assert response.thread_turn == 2
        assert response.suggestions[0].label == "Seat caps?"
        assert response.pending_approval.calls[0].credits_estimate == 5
        assert response.exchange.paid_calls == 0

    def test_status_payload_ignores_unknown_fields(self):
        """Old SDKs must survive server-side additions; new ones must too."""
        response = AgentResponse(
            **{
                "success": True,
                "id": "job-1",
                "status": "completed",
                "somethingNew": {"shipped": "later"},
            }
        )

        assert response.id == "job-1"


class TestGetAgentThread:
    """The thread read hits the documented path."""

    def _client(self):
        client = Mock()
        response = Mock()
        response.ok = True
        response.json.return_value = {
            "success": True,
            "thread": {
                "id": "thread-1",
                "createdAt": "2026-09-01T00:00:00Z",
                "updatedAt": "2026-09-01T00:01:00Z",
                "status": "idle",
                "runs": [
                    {
                        "id": "job-1",
                        "turn": 1,
                        "mode": "chat",
                        "prompt": "List the pricing tiers",
                        "status": "succeeded",
                        "createdAt": "2026-09-01T00:00:00Z",
                        "finishedAt": "2026-09-01T00:00:30Z",
                        "creditsUsed": 212,
                        "message": None,
                    },
                    {
                        "id": "job-2",
                        "turn": 2,
                        "mode": "chat",
                        "prompt": "Which tier has SSO?",
                        "status": "succeeded",
                        "createdAt": "2026-09-01T00:00:40Z",
                        "finishedAt": "2026-09-01T00:01:00Z",
                        "creditsUsed": 31,
                        "message": "Only the Enterprise tier lists SSO.",
                    },
                ],
            },
        }
        client.get.return_value = response
        return client

    def test_hits_the_thread_endpoint(self):
        client = self._client()

        result = get_agent_thread(client, "thread-1")

        client.get.assert_called_once_with("/v2/agent/threads/thread-1")
        assert isinstance(result, AgentThreadResponse)
        assert len(result.thread.runs) == 2
        assert result.thread.runs[1].credits_used == 31
        assert result.thread.runs[1].message == "Only the Enterprise tier lists SSO."

    def test_include_data_query(self):
        client = self._client()

        get_agent_thread(client, "thread-1", include_data=True)

        client.get.assert_called_once_with(
            "/v2/agent/threads/thread-1?includeData=true"
        )
