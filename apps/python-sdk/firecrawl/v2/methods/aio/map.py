from typing import Optional, Dict, Any
from ...types import MapOptions, MapData, LinkResult
from ...utils.http_client_async import AsyncHttpClient
from ...utils.error_handler import handle_response_error


def _prepare_map_request(url: str, options: Optional[MapOptions] = None) -> Dict[str, Any]:
    if not url or not url.strip():
        raise ValueError("URL cannot be empty")
    payload: Dict[str, Any] = {"url": url.strip()}
    if options is not None:
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
        if options.integration is not None:
            data["integration"] = options.integration.strip()
        if options.location is not None:
            data["location"] = options.location.model_dump(exclude_none=True)
        payload.update(data)
    return payload


async def map(client: AsyncHttpClient, url: str, options: Optional[MapOptions] = None) -> MapData:
    request_data = _prepare_map_request(url, options)
    response = await client.post("/v2/map", request_data)
    if response.status_code >= 400:
        handle_response_error(response, "map")
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    
    
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
            result_links.append(LinkResult(url=item.get("url", ""), title=item.get("title"), description=item.get("description")))
        elif isinstance(item, str):
            result_links.append(LinkResult(url=item))

    return MapData(links=result_links)

