import re
from typing import Dict, Any, Union, List, TypeVar, Type
from ...types import (
    SearchRequest,
    SearchData,
    Document,
    SearchResultWeb,
    SearchResultNews,
    SearchResultImages,
)
from ...utils.http_client_async import AsyncHttpClient
from ...utils.error_handler import handle_response_error
from ...utils.validation import validate_scrape_options, prepare_scrape_options

T = TypeVar("T")

async def search(
    client: AsyncHttpClient,
    request: SearchRequest
) -> SearchData:
    """
    Async search for documents.

    Args:
        client: Async HTTP client instance
        request: Search request

    Returns:
        SearchData with search results grouped by source type

    Raises:
        FirecrawlError: If the search operation fails
    """
    request_data = _prepare_search_request(request)
    try:
        response = await client.post("/v2/search", request_data)
        if response.status_code != 200:
            handle_response_error(response, "search")
        response_data = response.json()
        if not response_data.get("success"):
            handle_response_error(response, "search")
        data = response_data.get("data", {}) or {}
        out = SearchData()
        if "web" in data:
            out.web = _transform_array(data["web"], SearchResultWeb)
        if "news" in data:
            out.news = _transform_array(data["news"], SearchResultNews)
        if "images" in data:
            out.images = _transform_array(data["images"], SearchResultImages)
        return out
    except Exception as err:
        if hasattr(err, "response"):
            handle_response_error(getattr(err, "response"), "search")
        raise err

def _transform_array(arr: List[Any], result_type: Type[T]) -> List[Union[T, Document]]:
    """
    Transforms an array of items into a list of result_type or Document.
    If the item dict contains any of the special keys, it is treated as a Document.
    Otherwise, it is treated as result_type.
    If the item is not a dict, it is wrapped as result_type with url=item.
    """
    results: List[Union[T, Document]] = []
    for item in arr:
        if item and isinstance(item, dict):
            if (
                "markdown" in item or
                "html" in item or
                "rawHtml" in item or
                "links" in item or
                "screenshot" in item or
                "changeTracking" in item or
                "summary" in item or
                "json" in item
            ):
                results.append(Document(**item))
            else:
                results.append(result_type(**item))
        else:
            results.append(result_type(url=item))
    return results

def _validate_search_request(request: SearchRequest) -> SearchRequest:
    """
    Validate and normalize search request.

    Args:
        request: Search request to validate

    Returns:
        Validated request

    Raises:
        ValueError: If request is invalid
    """
    if not request.query or not request.query.strip():
        raise ValueError("Query cannot be empty")

    if request.limit is not None:
        if request.limit <= 0:
            raise ValueError("Limit must be positive")
        if request.limit > 100:
            raise ValueError("Limit cannot exceed 100")

    if request.timeout is not None:
        if request.timeout <= 0:
            raise ValueError("Timeout must be positive")
        if request.timeout > 300000:
            raise ValueError("Timeout cannot exceed 300000ms (5 minutes)")

    if request.sources is not None:
        valid_sources = {"web", "news", "images"}
        for source in request.sources:
            if isinstance(source, str):
                if source not in valid_sources:
                    raise ValueError(f"Invalid source type: {source}. Valid types: {valid_sources}")
            elif hasattr(source, 'type'):
                if source.type not in valid_sources:
                    raise ValueError(f"Invalid source type: {source.type}. Valid types: {valid_sources}")

    if request.location is not None:
        if not isinstance(request.location, str) or len(request.location.strip()) == 0:
            raise ValueError("Location must be a non-empty string")

    if request.tbs is not None:
        valid_tbs_values = {
            "qdr:h", "qdr:d", "qdr:w", "qdr:m", "qdr:y",
            "d", "w", "m", "y"
        }
        if request.tbs in valid_tbs_values:
            pass
        elif request.tbs.startswith("cdr:"):
            custom_date_pattern = r"^cdr:1,cd_min:\d{1,2}/\d{1,2}/\d{4},cd_max:\d{1,2}/\d{1,2}/\d{4}$"
            if not re.match(custom_date_pattern, request.tbs):
                raise ValueError(f"Invalid custom date range format: {request.tbs}. Expected format: cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY")
        else:
            raise ValueError(f"Invalid tbs value: {request.tbs}. Valid values: {valid_tbs_values} or custom date range format: cdr:1,cd_min:MM/DD/YYYY,cd_max:MM/DD/YYYY")

    if request.scrape_options is not None:
        validate_scrape_options(request.scrape_options)

    return request

def _prepare_search_request(request: SearchRequest) -> Dict[str, Any]:
    """
    Prepare a search request payload.

    Args:
        request: Search request

    Returns:
        Request payload dictionary
    """
    validated_request = _validate_search_request(request)
    data = validated_request.model_dump(exclude_none=True, by_alias=True)

    if "limit" not in data and validated_request.limit is not None:
        data["limit"] = validated_request.limit
    if "timeout" not in data and validated_request.timeout is not None:
        data["timeout"] = validated_request.timeout

    if validated_request.ignore_invalid_urls is not None:
        data["ignoreInvalidURLs"] = validated_request.ignore_invalid_urls
        data.pop("ignore_invalid_urls", None)

    if validated_request.scrape_options is not None:
        scrape_data = prepare_scrape_options(validated_request.scrape_options)
        if scrape_data:
            data["scrapeOptions"] = scrape_data
        data.pop("scrape_options", None)

    return data
