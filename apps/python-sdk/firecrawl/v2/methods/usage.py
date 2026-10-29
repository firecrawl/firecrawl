from ..utils import FirecrawlError, HttpClient, handle_response_error
from ..types import ConcurrencyCheck, CreditUsage, QueueStatusResponse, TokenUsage, CreditUsageHistoricalResponse, TokenUsageHistoricalResponse


def get_concurrency(client: HttpClient) -> ConcurrencyCheck:
    resp = client.get("/v2/concurrency-check")
    if not resp.ok:
        handle_response_error(resp, "get concurrency")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return ConcurrencyCheck(
        concurrency=data.get("concurrency"),
        max_concurrency=data.get("maxConcurrency", data.get("max_concurrency")),
    )


def get_credit_usage(client: HttpClient) -> CreditUsage:
    resp = client.get("/v2/team/credit-usage")
    if not resp.ok:
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


def get_token_usage(client: HttpClient) -> TokenUsage:
    resp = client.get("/v2/team/token-usage")
    if not resp.ok:
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

def get_queue_status(client: HttpClient) -> QueueStatusResponse:
    resp = client.get("/v2/team/queue-status")
    if not resp.ok:
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


def get_credit_usage_historical(client: HttpClient, by_api_key: bool = False) -> CreditUsageHistoricalResponse:
    resp = client.get(f"/v2/team/credit-usage/historical{'?byApiKey=true' if by_api_key else ''}")
    if not resp.ok:
        handle_response_error(resp, "get credit usage historical")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    return CreditUsageHistoricalResponse(**body)


def get_token_usage_historical(client: HttpClient, by_api_key: bool = False) -> TokenUsageHistoricalResponse:
    resp = client.get(f"/v2/team/token-usage/historical{'?byApiKey=true' if by_api_key else ''}")
    if not resp.ok:
        handle_response_error(resp, "get token usage historical")
    body = resp.json()
    if not body.get("success"):
        raise FirecrawlError(body.get("error", "Unknown error"))
    return TokenUsageHistoricalResponse(**body)
