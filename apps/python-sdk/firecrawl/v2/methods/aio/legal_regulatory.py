"""Async Legal and Regulatory Index search functionality for Firecrawl v2."""

from typing import Optional

from ...types import LegalRegulatorySearchRequest, LegalRegulatorySearchResponse
from ...utils.error_handler import handle_response_error
from ...utils.http_client_async import AsyncHttpClient


ENDPOINT = "/v2/search/gov"


async def legal_regulatory_search(
    client: AsyncHttpClient,
    query: str,
    *,
    k: Optional[int] = None,
) -> LegalRegulatorySearchResponse:
    """Search the Legal and Regulatory Index asynchronously."""
    if not query or not query.strip():
        raise ValueError("query cannot be empty")

    request = LegalRegulatorySearchRequest(query=query, k=k)
    response = await client.post(ENDPOINT, request.model_dump(exclude_none=True))
    if response.status_code != 200:
        handle_response_error(response, "search legal and regulatory sources")
    return LegalRegulatorySearchResponse.model_validate(response.json())
