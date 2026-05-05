import time
from typing import Any, Dict, List, Optional
from pydantic import BaseModel

from ..types import (
    Monitor,
    MonitorCheck,
    MonitorCheckDetail,
    MonitorCheckPage,
    MonitorCreateRequest,
    PaginationConfig,
    MonitorTarget,
    MonitorUpdateRequest,
    ScrapeOptions,
)
from ..utils import HttpClient, handle_response_error
from ..utils.validation import prepare_scrape_options


def _dump(value: Any) -> Any:
    if isinstance(value, ScrapeOptions):
        return prepare_scrape_options(value)
    if isinstance(value, MonitorTarget):
        data = value.model_dump(exclude_none=True, by_alias=True)
        if isinstance(value.scrape_options, ScrapeOptions):
            data["scrapeOptions"] = prepare_scrape_options(value.scrape_options)
        return _prepare_target(data)
    if isinstance(value, BaseModel):
        return value.model_dump(exclude_none=True, by_alias=True)
    if isinstance(value, list):
        return [_dump(item) for item in value]
    if isinstance(value, dict):
        return {key: _dump(item) for key, item in value.items() if item is not None}
    return value


def _prepare_target(target: Dict[str, Any]) -> Dict[str, Any]:
    prepared = dict(target)
    if "scrapeOptions" in prepared and isinstance(prepared["scrapeOptions"], ScrapeOptions):
        prepared["scrapeOptions"] = prepare_scrape_options(prepared["scrapeOptions"])
    if "crawlOptions" in prepared:
        prepared["crawlOptions"] = _dump(prepared["crawlOptions"])
    return prepared


def _prepare_payload(request: Any) -> Dict[str, Any]:
    payload = _dump(request)
    if not isinstance(payload, dict):
        raise ValueError("Monitor request must be an object")
    if "targets" in payload:
        payload["targets"] = [
            _prepare_target(_dump(target))
            for target in payload.get("targets", [])
        ]
    return payload


def _data_or_error(response, action: str) -> Any:
    if not response.ok:
        handle_response_error(response, action)
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    return body.get("data")


def _monitor_check_data_or_error(response, action: str) -> Dict[str, Any]:
    if not response.ok:
        handle_response_error(response, action)
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    data = body.get("data") or {}
    if body.get("next") is not None:
        data["next"] = body.get("next")
    return data


def _fetch_all_monitor_check_pages(
    client: HttpClient,
    next_url: str,
    initial_pages: List[MonitorCheckPage],
    pagination_config: Optional[PaginationConfig] = None,
) -> List[MonitorCheckPage]:
    pages = initial_pages.copy()
    current_url = next_url
    page_count = 0
    max_pages = pagination_config.max_pages if pagination_config else None
    max_results = pagination_config.max_results if pagination_config else None
    max_wait_time = pagination_config.max_wait_time if pagination_config else None
    start_time = time.monotonic()

    while current_url:
        if max_pages is not None and page_count >= max_pages:
            break
        if max_wait_time is not None and (time.monotonic() - start_time) > max_wait_time:
            break

        response = client.get(current_url)
        if not response.ok:
            break
        try:
            data = _monitor_check_data_or_error(response, "get monitor check page")
        except Exception:
            break

        for page in data.get("pages") or []:
            if max_results is not None and len(pages) >= max_results:
                break
            pages.append(MonitorCheckPage(**page))

        if max_results is not None and len(pages) >= max_results:
            break

        current_url = data.get("next")
        page_count += 1

    return pages


def create_monitor(client: HttpClient, request: MonitorCreateRequest) -> Monitor:
    data = _data_or_error(client.post("/v2/monitor", _prepare_payload(request)), "create monitor")
    return Monitor(**data)


def list_monitors(client: HttpClient, *, limit: Optional[int] = None, offset: Optional[int] = None) -> List[Monitor]:
    params = []
    if limit is not None:
        params.append(f"limit={limit}")
    if offset is not None:
        params.append(f"offset={offset}")
    suffix = f"?{'&'.join(params)}" if params else ""
    data = _data_or_error(client.get(f"/v2/monitor{suffix}"), "list monitors")
    return [Monitor(**item) for item in data or []]


def get_monitor(client: HttpClient, monitor_id: str) -> Monitor:
    data = _data_or_error(client.get(f"/v2/monitor/{monitor_id}"), "get monitor")
    return Monitor(**data)


def update_monitor(client: HttpClient, monitor_id: str, request: MonitorUpdateRequest) -> Monitor:
    data = _data_or_error(client.patch(f"/v2/monitor/{monitor_id}", _prepare_payload(request)), "update monitor")
    return Monitor(**data)


def delete_monitor(client: HttpClient, monitor_id: str) -> bool:
    response = client.delete(f"/v2/monitor/{monitor_id}")
    if not response.ok:
        handle_response_error(response, "delete monitor")
    body = response.json()
    if not body.get("success"):
        raise Exception(body.get("error", "Unknown error occurred"))
    return True


def run_monitor(client: HttpClient, monitor_id: str) -> MonitorCheck:
    data = _data_or_error(client.post(f"/v2/monitor/{monitor_id}/run", {}), "run monitor")
    return MonitorCheck(**data)


def list_monitor_checks(
    client: HttpClient,
    monitor_id: str,
    *,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> List[MonitorCheck]:
    params = []
    if limit is not None:
        params.append(f"limit={limit}")
    if offset is not None:
        params.append(f"offset={offset}")
    suffix = f"?{'&'.join(params)}" if params else ""
    data = _data_or_error(client.get(f"/v2/monitor/{monitor_id}/checks{suffix}"), "list monitor checks")
    return [MonitorCheck(**item) for item in data or []]


def get_monitor_check(
    client: HttpClient,
    monitor_id: str,
    check_id: str,
    *,
    limit: Optional[int] = None,
    skip: Optional[int] = None,
    status: Optional[str] = None,
    pagination_config: Optional[PaginationConfig] = None,
) -> MonitorCheckDetail:
    params = []
    if limit is not None:
        params.append(f"limit={limit}")
    if skip is not None:
        params.append(f"skip={skip}")
    if status is not None:
        params.append(f"status={status}")
    suffix = f"?{'&'.join(params)}" if params else ""
    data = _monitor_check_data_or_error(client.get(f"/v2/monitor/{monitor_id}/checks/{check_id}{suffix}"), "get monitor check")
    detail = MonitorCheckDetail(**data)

    auto_paginate = pagination_config.auto_paginate if pagination_config else True
    if auto_paginate and detail.next and not (
        pagination_config
        and pagination_config.max_results is not None
        and len(detail.pages) >= pagination_config.max_results
    ):
        detail.pages = _fetch_all_monitor_check_pages(
            client,
            detail.next,
            detail.pages,
            pagination_config,
        )
        detail.next = None

    return detail
