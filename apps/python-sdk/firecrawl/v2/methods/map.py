"""
Mapping functionality for Firecrawl v2 API.
"""

from typing import Optional, Dict, Any
from ..types import MapOptions, MapData, LinkResult
from ..utils import HttpClient, handle_response_error


def _prepare_map_request(url: str, options: Optional[MapOptions] = None) -> Dict[str, Any]:
    if not url or not url.strip():
        raise ValueError("URL cannot be empty")

    payload: Dict[str, Any] = {"url": url.strip()}

    if options is not None:
        # Unified sitemap parameter already provided in options
        data: Dict[str, Any] = {}
        if getattr(options, "sitemap", None) is not None:
            data["sitemap"] = options.sitemap

        if options.search is not None:
            data["search"] = options.search
        if options.include_subdomains is not None:
            data["includeSubdomains"] = options.include_subdomains
        if options.ignore_query_parameters is not None:
            data["ignoreQueryParameters"] = options.ignore_query_parameters
        if options.limit is not None:
            data["limit"] = options.limit
        if options.timeout is not None:
            data["timeout"] = options.timeout
        if options.integration is not None and options.integration.strip():
            data["integration"] = options.integration.strip()
        if options.location is not None:
            data["location"] = options.location.model_dump(exclude_none=True)
        payload.update(data)

    return payload


def map(client: HttpClient, url: str, options: Optional[MapOptions] = None) -> MapData:
    """
    Map a URL and return MapData (links list with optional titles/descriptions).
    """
    request_data = _prepare_map_request(url, options)
    response = client.post("/v2/map", request_data)
    if not response.ok:
        handle_response_error(response, "map")

    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))

    # shouldnt return inside data?
    # data = body.get("data", {})
    # result_links: list[LinkResult] = []
    # for item in data.get("links", []):
    #     if isinstance(item, dict):
    #         result_links.append(
    #             LinkResult(
    #                 url=item.get("url", ""),
    #                 title=item.get("title"),
    #                 description=item.get("description"),
    #             )
    #         )
    #     elif isinstance(item, str):
    #         result_links.append(LinkResult(url=item))

    result_links: list[LinkResult] = []
    for item in body.get("links", []):
        if isinstance(item, dict):
            result_links.append(
                LinkResult(
                    url=item.get("url", ""),
                    title=item.get("title"),
                    description=item.get("description"),
                )
            )
        elif isinstance(item, str):
            result_links.append(LinkResult(url=item))

    return MapData(links=result_links)

