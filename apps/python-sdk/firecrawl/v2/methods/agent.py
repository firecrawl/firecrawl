from typing import Any, Dict, List, Literal, Optional, Union
import time

from ..types import AgentResponse, AgentWebhookConfig
from ..utils.http_client import HttpClient
from ..utils.error_handler import handle_response_error
from ..utils.validation import _normalize_schema


def _prepare_agent_request(
    urls: Optional[List[str]],
    *,
    prompt: str,
    schema: Optional[Any] = None,
    integration: Optional[str] = None,
    max_credits: Optional[int] = None,
    zero_data_retention: Optional[bool] = None,
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
    if zero_data_retention is not None:
        body["zeroDataRetention"] = zero_data_retention
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


def start_agent(
    client: HttpClient,
    urls: Optional[List[str]],
    *,
    prompt: str,
    schema: Optional[Any] = None,
    integration: Optional[str] = None,
    max_credits: Optional[int] = None,
    zero_data_retention: Optional[bool] = None,
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
        zero_data_retention=zero_data_retention,
        strict_constrain_to_urls=strict_constrain_to_urls,
        model=model,
        webhook=webhook,
    )
    resp = client.post("/v2/agent", body)
    if not resp.ok:
        handle_response_error(resp, "agent")
    payload = _normalize_agent_response_payload(resp.json())
    return AgentResponse(**payload)


def get_agent_status(client: HttpClient, job_id: str) -> AgentResponse:
    resp = client.get(f"/v2/agent/{job_id}")
    if not resp.ok:
        handle_response_error(resp, "agent-status")
    payload = _normalize_agent_response_payload(resp.json())
    return AgentResponse(**payload)


def wait_agent(
    client: HttpClient,
    job_id: str,
    *,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
) -> AgentResponse:
    start_ts = time.time()
    while True:
        status = get_agent_status(client, job_id)
        if status.status in ("completed", "failed", "cancelled"):
            return status
        if timeout is not None and (time.time() - start_ts) > timeout:
            return status
        time.sleep(max(1, poll_interval))


def agent(
    client: HttpClient,
    urls: Optional[List[str]],
    *,
    prompt: str,
    schema: Optional[Any] = None,
    integration: Optional[str] = None,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
    max_credits: Optional[int] = None,
    zero_data_retention: Optional[bool] = None,
    strict_constrain_to_urls: Optional[bool] = None,
    model: Optional[Literal["spark-1-pro", "spark-1-mini"]] = None,
    webhook: Optional[Union[str, AgentWebhookConfig]] = None,
) -> AgentResponse:
    started = start_agent(
        client,
        urls,
        prompt=prompt,
        schema=schema,
        integration=integration,
        max_credits=max_credits,
        zero_data_retention=zero_data_retention,
        strict_constrain_to_urls=strict_constrain_to_urls,
        model=model,
        webhook=webhook,
    )
    job_id = getattr(started, "id", None)
    if not job_id:
        return started
    return wait_agent(client, job_id, poll_interval=poll_interval, timeout=timeout)


def cancel_agent(client: HttpClient, job_id: str) -> bool:
    """
    Cancel a running agent job.

    Args:
        client: HTTP client instance
        job_id: ID of the agent job to cancel

    Returns:
        bool: True if the agent was cancelled, False otherwise

    Raises:
        Exception: If the cancellation fails
    """
    resp = client.delete(f"/v2/agent/{job_id}")
    if not resp.ok:
        handle_response_error(resp, "cancel agent")
    return resp.json().get("success", False)
