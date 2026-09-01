from typing import Any, Dict, List, Literal, Optional, Union
import asyncio

from ...types import (
    AgentExchangeOptions,
    AgentListResponse,
    AgentResponse,
    AgentSnapshotResponse,
    AgentThreadResponse,
    AgentTraceResponse,
    AgentWebhookConfig,
    AuditMetadata,
    ThreatProtectionOptions,
)
from ...utils.error_handler import handle_response_error
from ...utils.http_client_async import AsyncHttpClient
from ...utils.validation import _normalize_schema


def _prepare_agent_request(
    urls: Optional[List[str]],
    *,
    prompt: str,
    schema: Optional[Any] = None,
    integration: Optional[str] = None,
    max_credits: Optional[int] = None,
    strict_constrain_to_urls: Optional[bool] = None,
    model: Optional[Literal["spark-1-pro", "spark-1-mini", "spark-2"]] = None,
    effort: Optional[Literal["low", "medium", "high"]] = None,
    webhook: Optional[Union[str, AgentWebhookConfig]] = None,
    threat_protection: Optional[ThreatProtectionOptions] = None,
    audit_metadata: Optional[AuditMetadata] = None,
    thread_id: Optional[str] = None,
    mode: Optional[Literal["extract", "chat"]] = None,
    exchange: Optional[Union[AgentExchangeOptions, Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    body: Dict[str, Any] = {}
    if urls is not None:
        body["urls"] = urls
    body["prompt"] = prompt
    if schema is not None:
        normalized_schema = _normalize_schema(schema)
        if normalized_schema is not None:
            body["schema"] = normalized_schema
        else:
            raise ValueError(
                f"Invalid schema type: {type(schema).__name__}. "
                "Schema must be a dict, Pydantic BaseModel class, or Pydantic model instance."
            )
    if integration is not None and str(integration).strip():
        body["integration"] = str(integration).strip()
    if max_credits is not None and max_credits > 0:
        body["maxCredits"] = max_credits
    if strict_constrain_to_urls is not None and strict_constrain_to_urls:
        body["strictConstrainToURLs"] = strict_constrain_to_urls
    if model is not None:
        body["model"] = model
    if effort is not None:
        body["effort"] = effort
    if webhook is not None:
        if isinstance(webhook, str):
            body["webhook"] = webhook
        else:
            body["webhook"] = webhook.model_dump(exclude_none=True)
    if threat_protection is not None:
        body["threatProtection"] = threat_protection.model_dump(
            by_alias=True, exclude_none=True
        )
    if audit_metadata is not None:
        body["auditMetadata"] = audit_metadata.model_dump()
    if thread_id is not None:
        body["threadId"] = thread_id
    if mode is not None:
        body["mode"] = mode
    if exchange is not None:
        body["exchange"] = (
            exchange
            if isinstance(exchange, dict)
            else exchange.model_dump(by_alias=True, exclude_none=True)
        )
    return body


def _normalize_agent_response_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "expiresAt" in out and "expires_at" not in out:
        out["expires_at"] = out["expiresAt"]
    if "creditsUsed" in out and "credits_used" not in out:
        out["credits_used"] = out["creditsUsed"]
    return out


async def start_agent(
    client: AsyncHttpClient,
    urls: Optional[List[str]],
    *,
    prompt: str,
    schema: Optional[Any] = None,
    integration: Optional[str] = None,
    max_credits: Optional[int] = None,
    strict_constrain_to_urls: Optional[bool] = None,
    model: Optional[Literal["spark-1-pro", "spark-1-mini", "spark-2"]] = None,
    effort: Optional[Literal["low", "medium", "high"]] = None,
    webhook: Optional[Union[str, AgentWebhookConfig]] = None,
    threat_protection: Optional[ThreatProtectionOptions] = None,
    audit_metadata: Optional[AuditMetadata] = None,
    thread_id: Optional[str] = None,
    mode: Optional[Literal["extract", "chat"]] = None,
    exchange: Optional[Union[AgentExchangeOptions, Dict[str, Any]]] = None,
) -> AgentResponse:
    body = _prepare_agent_request(
        urls,
        prompt=prompt,
        schema=schema,
        integration=integration,
        max_credits=max_credits,
        strict_constrain_to_urls=strict_constrain_to_urls,
        model=model,
        effort=effort,
        webhook=webhook,
        threat_protection=threat_protection,
        audit_metadata=audit_metadata,
        thread_id=thread_id,
        mode=mode,
        exchange=exchange,
    )
    resp = await client.post("/v2/agent", body)
    if not resp.ok:
        handle_response_error(resp, "agent")
    payload = _normalize_agent_response_payload(resp.json())
    return AgentResponse(**payload)


async def get_agent_status(client: AsyncHttpClient, job_id: str) -> AgentResponse:
    resp = await client.get(f"/v2/agent/{job_id}")
    if not resp.ok:
        handle_response_error(resp, "agent-status")
    payload = _normalize_agent_response_payload(resp.json())
    return AgentResponse(**payload)


async def list_agents(
    client: AsyncHttpClient,
    *,
    before: Optional[int] = None,
) -> AgentListResponse:
    """List agent runs, most recent first.

    Pages are fixed at 20 runs. To fetch the next page, pass the `before`
    value from the previous page's `next` URL. This method does not
    auto-paginate.

    Args:
        client: Async HTTP client instance
        before: Only return agent runs created before this unix ms timestamp

    Returns:
        AgentListResponse with the list of agent runs and optional next URL
    """
    endpoint = "/v2/agent"
    if before is not None:
        endpoint = f"{endpoint}?before={before}"
    resp = await client.get(endpoint)
    if not resp.ok:
        handle_response_error(resp, "list agents")
    return AgentListResponse(**resp.json())


async def wait_agent(
    client: AsyncHttpClient,
    job_id: str,
    *,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
) -> AgentResponse:
    start_ts = asyncio.get_event_loop().time()
    while True:
        status = await get_agent_status(client, job_id)
        if status.status in ("completed", "failed", "cancelled"):
            return status
        if timeout is not None and (asyncio.get_event_loop().time() - start_ts) > timeout:
            return status
        await asyncio.sleep(max(1, poll_interval))


async def agent(
    client: AsyncHttpClient,
    urls: Optional[List[str]],
    *,
    prompt: str,
    schema: Optional[Any] = None,
    integration: Optional[str] = None,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
    max_credits: Optional[int] = None,
    strict_constrain_to_urls: Optional[bool] = None,
    model: Optional[Literal["spark-1-pro", "spark-1-mini", "spark-2"]] = None,
    effort: Optional[Literal["low", "medium", "high"]] = None,
    webhook: Optional[Union[str, AgentWebhookConfig]] = None,
    threat_protection: Optional[ThreatProtectionOptions] = None,
    audit_metadata: Optional[AuditMetadata] = None,
    thread_id: Optional[str] = None,
    mode: Optional[Literal["extract", "chat"]] = None,
    exchange: Optional[Union[AgentExchangeOptions, Dict[str, Any]]] = None,
) -> AgentResponse:
    started = await start_agent(
        client,
        urls,
        prompt=prompt,
        schema=schema,
        integration=integration,
        max_credits=max_credits,
        strict_constrain_to_urls=strict_constrain_to_urls,
        model=model,
        effort=effort,
        webhook=webhook,
        threat_protection=threat_protection,
        audit_metadata=audit_metadata,
        thread_id=thread_id,
        mode=mode,
        exchange=exchange,
    )
    job_id = getattr(started, "id", None)
    if not job_id:
        return started
    return await wait_agent(client, job_id, poll_interval=poll_interval, timeout=timeout)


async def get_agent_trace(
    client: AsyncHttpClient,
    job_id: str,
    *,
    live_view: bool = False,
) -> AgentTraceResponse:
    """Get the execution trace of an agent job (spark-2 runs only).

    Args:
        client: Async HTTP client instance
        job_id: ID of the agent job
        live_view: Also include currently active browser sessions with live view URLs
    """
    endpoint = f"/v2/agent/{job_id}/trace"
    if live_view:
        endpoint += "?liveView=true"
    resp = await client.get(endpoint)
    if not resp.ok:
        handle_response_error(resp, "agent-trace")
    return AgentTraceResponse(**resp.json())


async def get_agent_thread(
    client: AsyncHttpClient,
    thread_id: str,
    *,
    include_data: bool = False,
) -> AgentThreadResponse:
    """Get a thread and its runs, oldest turn first.

    Args:
        client: Async HTTP client instance
        thread_id: Thread ID, as returned by start_agent or get_agent_status
        include_data: Inline each succeeded run's data
    """
    endpoint = f"/v2/agent/threads/{thread_id}"
    if include_data:
        endpoint += "?includeData=true"
    resp = await client.get(endpoint)
    if not resp.ok:
        handle_response_error(resp, "agent-thread")
    return AgentThreadResponse(**resp.json())


async def get_agent_snapshot(
    client: AsyncHttpClient,
    job_id: str,
    snapshot_id: str,
) -> AgentSnapshotResponse:
    """Get the full content of an artifact snapshot referenced by a trace event.

    Args:
        client: Async HTTP client instance
        job_id: ID of the agent job
        snapshot_id: Snapshot ID from an artifact.updated trace event
    """
    resp = await client.get(f"/v2/agent/{job_id}/snapshots/{snapshot_id}")
    if not resp.ok:
        handle_response_error(resp, "agent-snapshot")
    return AgentSnapshotResponse(**resp.json())


async def cancel_agent(client: AsyncHttpClient, job_id: str) -> bool:
    """
    Cancel a running agent job.

    Args:
        client: Async HTTP client instance
        job_id: ID of the agent job to cancel

    Returns:
        bool: True if the agent was cancelled, False otherwise

    Raises:
        Exception: If the cancellation fails
    """
    resp = await client.delete(f"/v2/agent/{job_id}")
    if not resp.ok:
        handle_response_error(resp, "cancel agent")
    return resp.json().get("success", False)
