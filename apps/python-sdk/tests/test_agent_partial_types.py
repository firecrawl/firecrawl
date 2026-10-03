from firecrawl.v2.types import AgentResponse, AgentThreadRun


def test_agent_status_preserves_credit_limit_partial():
    response = AgentResponse.model_validate(
        {
            "success": True,
            "status": "failed",
            "stopReason": "credit_limit_reached",
            "partial": {"companies": [{"name": "Acme"}]},
            "partialSchemaValid": False,
        }
    )

    assert response.data is None
    assert response.stop_reason == "credit_limit_reached"
    assert response.partial == {"companies": [{"name": "Acme"}]}
    assert response.partial_schema_valid is False


def test_agent_thread_run_preserves_partial_for_continuation():
    run = AgentThreadRun.model_validate(
        {
            "id": "job-123",
            "status": "credit_limit_reached",
            "stopReason": "credit_limit_reached",
            "partial": {"companies": [{"name": "Acme"}]},
            "partialSchemaValid": False,
        }
    )

    assert run.partial == {"companies": [{"name": "Acme"}]}
    assert run.partial_schema_valid is False
    assert run.stop_reason == "credit_limit_reached"
