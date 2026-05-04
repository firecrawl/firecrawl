from typing import Any, Dict, List, Optional
from pydantic import BaseModel

from ..types import (
    Monitor,
    MonitorCheck,
    MonitorCheckDetail,
    MonitorCreateRequest,
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
    offset: Optional[int] = None,
    status: Optional[str] = None,
) -> MonitorCheckDetail:
    params = []
    if limit is not None:
        params.append(f"limit={limit}")
    if offset is not None:
        params.append(f"offset={offset}")
    if status is not None:
        params.append(f"status={status}")
    suffix = f"?{'&'.join(params)}" if params else ""
    data = _data_or_error(client.get(f"/v2/monitor/{monitor_id}/checks/{check_id}{suffix}"), "get monitor check")
    return MonitorCheckDetail(**data)
