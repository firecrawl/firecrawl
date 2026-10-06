"""Government Index search functionality for Firecrawl v2."""

from typing import Optional

from ..types import LegalRegulatorySearchRequest, LegalRegulatorySearchResponse
from ..utils import HttpClient, handle_response_error


ENDPOINT = "/v2/search/gov"


def legal_regulatory_search(
    client: HttpClient,
    query: str,
    *,
    k: Optional[int] = None,
) -> LegalRegulatorySearchResponse:
    """Search the Government Index."""
    if not query or not query.strip():
        raise ValueError("query cannot be empty")

    request = LegalRegulatorySearchRequest(query=query, k=k)
    response = client.post(ENDPOINT, request.model_dump(exclude_none=True))
    if response.status_code != 200:
        handle_response_error(response, "search the Government Index")
    response_data = response.json()
    if not response_data.get("success"):
        handle_response_error(response, "search the Government Index")
    return LegalRegulatorySearchResponse.model_validate(response_data)
