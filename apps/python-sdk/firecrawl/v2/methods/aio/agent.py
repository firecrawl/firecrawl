from typing import Any, Dict, List, Literal, Optional, Union
import asyncio

from ...types import AgentResponse, AgentWebhookConfig
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
    model: Optional[Literal["spark-1-pro", "spark-1-mini"]] = None,
    webhook: Optional[Union[str, AgentWebhookConfig]] = None,
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
    if webhook is not None:
        if isinstance(webhook, str):
            body["webhook"] = webhook
        else:
            body["webhook"] = webhook.model_dump(exclude_none=True)
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
    model: Optional[Literal["spark-1-pro", "spark-1-mini"]] = None,
    webhook: Optional[Union[str, AgentWebhookConfig]] = None,
) -> AgentResponse:
    body = _prepare_agent_request(
        urls,
        prompt=prompt,
        schema=schema,
        integration=integration,
        max_credits=max_credits,
        strict_constrain_to_urls=strict_constrain_to_urls,
        model=model,
        webhook=webhook,
    )
    resp = await client.post("/v2/agent", body)
    payload = _normalize_agent_response_payload(resp.json())
    return AgentResponse(**payload)


async def get_agent_status(client: AsyncHttpClient, job_id: str) -> AgentResponse:
    resp = await client.get(f"/v2/agent/{job_id}")
    payload = _normalize_agent_response_payload(resp.json())
    return AgentResponse(**payload)


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
    model: Optional[Literal["spark-1-pro", "spark-1-mini"]] = None,
    webhook: Optional[Union[str, AgentWebhookConfig]] = None,
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
        webhook=webhook,
    )
    job_id = getattr(started, "id", None)
    if not job_id:
        return started
    return await wait_agent(client, job_id, poll_interval=poll_interval, timeout=timeout)


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
    return resp.json().get("success", False)
