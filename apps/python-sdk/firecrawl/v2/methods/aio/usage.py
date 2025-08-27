from ...utils.http_client_async import AsyncHttpClient
from ...utils.error_handler import handle_response_error
from ...types import ConcurrencyCheck, CreditUsage, TokenUsage


async def get_concurrency(client: AsyncHttpClient) -> ConcurrencyCheck:
    resp = await client.get("/v2/concurrency-check")
    if resp.status_code >= 400:
        handle_response_error(resp, "get concurrency")
    body = resp.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error"))
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
        raise Exception(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return CreditUsage(remaining_credits=data.get("remainingCredits", data.get("remaining_credits", 0)))


async def get_token_usage(client: AsyncHttpClient) -> TokenUsage:
    resp = await client.get("/v2/team/token-usage")
    if resp.status_code >= 400:
        handle_response_error(resp, "get token usage")
    body = resp.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return TokenUsage(
        remaining_tokens=data.get("remainingTokens", 0)
    )

