"""Async Government Index search functionality for Firecrawl v2."""

from typing import List, Optional, Union

from ...types import GovSearchCourtType, GovSearchRequest, GovSearchResponse, GovSearchSource
from ...utils.error_handler import handle_response_error
from ...utils.http_client_async import AsyncHttpClient


ENDPOINT = "/v2/search/gov"


async def gov_search(
    client: AsyncHttpClient,
    query: str,
    *,
    k: Optional[int] = None,
    jurisdiction: Optional[str] = None,
    court: Optional[str] = None,
    court_type: Optional[GovSearchCourtType] = None,
    cites: Optional[Union[str, List[str]]] = None,
    domain: Optional[str] = None,
    sources: Optional[List[GovSearchSource]] = None,
) -> GovSearchResponse:
    """Search the Government Index asynchronously."""
    if not query or not query.strip():
        raise ValueError("query cannot be empty")

    request = GovSearchRequest(
        query=query,
        k=k,
        jurisdiction=jurisdiction,
        court=court,
        court_type=court_type,
        cites=cites,
        domain=domain,
        sources=sources,
    )
    response = await client.post(ENDPOINT, request.model_dump(exclude_none=True, by_alias=True))
    if response.status_code != 200:
        handle_response_error(response, "search the Government Index")
    response_data = response.json()
    if not response_data.get("success"):
        handle_response_error(response, "search the Government Index")
    return GovSearchResponse.model_validate(response_data)
