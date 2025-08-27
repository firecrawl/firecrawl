from ..utils import HttpClient, handle_response_error
from ..types import ConcurrencyCheck, CreditUsage, TokenUsage


def get_concurrency(client: HttpClient) -> ConcurrencyCheck:
    resp = client.get("/v2/concurrency-check")
    if not resp.ok:
        handle_response_error(resp, "get concurrency")
    body = resp.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error"))
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
        raise Exception(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return CreditUsage(remaining_credits=data.get("remainingCredits", data.get("remaining_credits", 0)))


def get_token_usage(client: HttpClient) -> TokenUsage:
    resp = client.get("/v2/team/token-usage")
    if not resp.ok:
        handle_response_error(resp, "get token usage")
    body = resp.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error"))
    data = body.get("data", body)
    return TokenUsage(
        remaining_tokens=data.get("remainingTokens", 0)
    )

