"""Async dedicated developer-search functionality for Firecrawl v2."""

from typing import List, Literal, Optional

from ...types import (
    DeveloperSearchRequest,
    DeveloperSearchResponse,
    DeveloperSearchType,
)
from ...utils.error_handler import handle_response_error
from ...utils.http_client_async import AsyncHttpClient


ENDPOINT = "/v2/search/developer"


async def developer_search(
    client: AsyncHttpClient,
    query: str,
    *,
    k: Optional[int] = None,
    passages: Optional[int] = None,
    types: Optional[List[DeveloperSearchType]] = None,
    repos: Optional[List[str]] = None,
    sources: Optional[List[str]] = None,
    language: Optional[str] = None,
    topic: Optional[List[str]] = None,
    license: Optional[str] = None,
    min_stars: Optional[int] = None,
    max_stars: Optional[int] = None,
    archived: Optional[bool] = None,
    fork: Optional[bool] = None,
    skills: Optional[Literal["only"]] = None,
) -> DeveloperSearchResponse:
    """Search the developer index asynchronously with all dedicated filters."""
    if not query or not query.strip():
        raise ValueError("query cannot be empty")

    request = DeveloperSearchRequest(
        query=query,
        k=k,
        passages=passages,
        types=types,
        repos=repos,
        sources=sources,
        language=language,
        topic=topic,
        license=license,
        min_stars=min_stars,
        max_stars=max_stars,
        archived=archived,
        fork=fork,
        skills=skills,
    )
    response = await client.post(ENDPOINT, request.model_dump(exclude_none=True))
    if response.status_code != 200:
        handle_response_error(response, "search developer sources")
    return DeveloperSearchResponse.model_validate(response.json())
