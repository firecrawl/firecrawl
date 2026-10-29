from ...utils.http_client_async import AsyncHttpClient
from ...utils.error_handler import FirecrawlError, handle_response_error
from ...types import ConcurrencyCheck, CreditUsage, TokenUsage, CreditUsageHistoricalResponse, TokenUsageHistoricalResponse, QueueStatusResponse


async def get_concurrency(client: AsyncHttpClient) -> ConcurrencyCheck:
    resp = await client.get("/v2/concurrency-check")
    if resp.status_code >= 400:
        handle_response_error(resp, "get concurrency")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return ConcurrencyCheck(
        concurrency=data.get("concurrency"),
        max_concurrency=data.get("maxConcurrency", data.get("max_concurrency")),
    )


async def get_credit_usage(client: AsyncHttpClient) -> CreditUsage:
    resp = await client.get("/v2/team/credit-usage")
    if resp.status_code >= 400:
        handle_response_error(resp, "get credit usage")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return CreditUsage(
        remaining_credits=data.get("remainingCredits", data.get("remaining_credits", 0)),
        plan_credits=data.get("planCredits", data.get("plan_credits")),
        billing_period_start=data.get("billingPeriodStart", data.get("billing_period_start")),
        billing_period_end=data.get("billingPeriodEnd", data.get("billing_period_end")),
    )


async def get_token_usage(client: AsyncHttpClient) -> TokenUsage:
    resp = await client.get("/v2/team/token-usage")
    if resp.status_code >= 400:
        handle_response_error(resp, "get token usage")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return TokenUsage(
        remaining_tokens=data.get("remainingTokens", data.get("remaining_tokens", 0)),
        plan_tokens=data.get("planTokens", data.get("plan_tokens")),
        billing_period_start=data.get("billingPeriodStart", data.get("billing_period_start")),
        billing_period_end=data.get("billingPeriodEnd", data.get("billing_period_end")),
    )


async def get_queue_status(client: AsyncHttpClient) -> QueueStatusResponse:
    resp = await client.get("/v2/team/queue-status")
    if resp.status_code >= 400:
        handle_response_error(resp, "get queue status")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return QueueStatusResponse(
        jobs_in_queue=data.get("jobsInQueue", 0),
        active_jobs_in_queue=data.get("activeJobsInQueue", 0),
        waiting_jobs_in_queue=data.get("waitingJobsInQueue", 0),
        max_concurrency=data.get("maxConcurrency", 0),
        most_recent_success=data.get("mostRecentSuccess", None),
    )


async def get_credit_usage_historical(client: AsyncHttpClient, by_api_key: bool = False) -> CreditUsageHistoricalResponse:
    query = "?byApiKey=true" if by_api_key else ""
    resp = await client.get(f"/v2/team/credit-usage/historical{query}")
    if resp.status_code >= 400:
        handle_response_error(resp, "get credit usage historical")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    return CreditUsageHistoricalResponse(**body)


async def get_token_usage_historical(client: AsyncHttpClient, by_api_key: bool = False) -> TokenUsageHistoricalResponse:
    query = "?byApiKey=true" if by_api_key else ""
    resp = await client.get(f"/v2/team/token-usage/historical{query}")
    if resp.status_code >= 400:
        handle_response_error(resp, "get token usage historical")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    return TokenUsageHistoricalResponse(**body)

