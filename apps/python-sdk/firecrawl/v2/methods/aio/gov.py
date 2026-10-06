"""Async Government Index search functionality for Firecrawl v2."""

from typing import Optional

from ...types import GovSearchRequest, GovSearchResponse
from ...utils.error_handler import handle_response_error
from ...utils.http_client_async import AsyncHttpClient


ENDPOINT = "/v2/search/gov"


async def gov_search(
    client: AsyncHttpClient,
    query: str,
    *,
    k: Optional[int] = None,
) -> GovSearchResponse:
    """Search the Government Index asynchronously."""
    if not query or not query.strip():
        raise ValueError("query cannot be empty")

    request = GovSearchRequest(query=query, k=k)
    response = await client.post(ENDPOINT, request.model_dump(exclude_none=True))
    if response.status_code != 200:
        handle_response_error(response, "search the Government Index")
    response_data = response.json()
    if not response_data.get("success"):
        handle_response_error(response, "search the Government Index")
    return GovSearchResponse.model_validate(response_data)
