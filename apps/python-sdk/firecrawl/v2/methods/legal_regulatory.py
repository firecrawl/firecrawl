"""Legal and Regulatory Index search functionality for Firecrawl v2."""

from typing import Optional

from ..types import LegalRegulatorySearchRequest, LegalRegulatorySearchResponse
from ..utils import HttpClient, handle_response_error


ENDPOINT = "/v2/search/legal-regulatory"


def legal_regulatory_search(
    client: HttpClient,
    query: str,
    *,
    k: Optional[int] = None,
) -> LegalRegulatorySearchResponse:
    """Search the Legal and Regulatory Index."""
    if not query or not query.strip():
        raise ValueError("query cannot be empty")

    request = LegalRegulatorySearchRequest(query=query, k=k)
    response = client.post(ENDPOINT, request.model_dump(exclude_none=True))
    if response.status_code != 200:
        handle_response_error(response, "search legal and regulatory sources")
    return LegalRegulatorySearchResponse.model_validate(response.json())
