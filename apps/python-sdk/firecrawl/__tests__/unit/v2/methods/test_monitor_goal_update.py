import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from firecrawl.v2.client import FirecrawlClient
from firecrawl.v2.client_async import AsyncFirecrawlClient
from firecrawl.v2.methods import monitor
from firecrawl.v2.methods.aio import monitor as async_monitor
from firecrawl.v2.types import MonitorCreateRequest, MonitorUpdateRequest


@pytest.fixture
def monitor_server():
    state = {
        "id": "monitor-1",
        "name": "Original name",
        "status": "active",
        "schedule": {"cron": "0 * * * *", "timezone": "UTC"},
        "targets": [{"type": "scrape", "url": "https://example.com"}],
        "goal": "Original goal",
        "judgeEnabled": True,
        "retentionDays": 14,
        "webhook": {"url": "https://example.com/hook"},
        "notification": {"email": {"enabled": False}},
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
    }
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_PATCH(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, payload))
            for key, value in payload.items():
                if key == "goal":
                    # Match the API's normalizeGoal: null/blank clears, omission preserves.
                    state[key] = (value.strip() or None) if value is not None else None
                elif key != "origin":
                    state[key] = value
            body = json.dumps({"success": True, "data": state}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}", requests
        finally:
            server.shutdown()
            thread.join(timeout=2)


@pytest.mark.parametrize("client_kind", ["sync", "async"])
@pytest.mark.parametrize(
    "options,expected_payload,expected_goal",
    [
        pytest.param(
            {"name": "Renamed", "webhook": None, "notification": None},
            {"name": "Renamed"},
            "Original goal",
            id="omitted",
        ),
        pytest.param(
            {"goal": None, "judge_enabled": False},
            {"goal": None, "judgeEnabled": False},
            None,
            id="clear",
        ),
        pytest.param(
            {"goal": "  New goal  "},
            {"goal": "  New goal  "},
            "New goal",
            id="replace",
        ),
        pytest.param({"goal": ""}, {"goal": ""}, None, id="empty-string"),
    ],
)
def test_public_update_monitor_goal_over_http(
    monitor_server, client_kind, options, expected_payload, expected_goal
):
    api_url, requests = monitor_server
    client_options = {
        "api_key": "fc-test",
        "api_url": api_url,
        "timeout": 2,
        "max_retries": 1,
        "origin": "monitor-goal-test",
    }
    if client_kind == "sync":
        result = FirecrawlClient(**client_options).update_monitor("monitor-1", **options)
    else:
        async def update():
            client = AsyncFirecrawlClient(**client_options)
            try:
                return await client.update_monitor("monitor-1", **options)
            finally:
                await client.async_http_client.close()

        result = asyncio.run(update())

    assert requests == [
        ("/v2/monitor/monitor-1", {**expected_payload, "origin": "monitor-goal-test"})
    ]
    assert result.goal == expected_goal
    assert result.retention_days == 14
    assert result.webhook == {"url": "https://example.com/hook"}
    assert result.notification == {"email": {"enabled": False}}
    assert result.judge_enabled is options.get("judge_enabled", True)


@pytest.mark.parametrize("prepare", [monitor._prepare_payload, async_monitor._prepare_payload])
@pytest.mark.parametrize(
    "options,expected_goal",
    [
        pytest.param({}, {}, id="omitted"),
        pytest.param({"goal": None}, {"goal": None}, id="explicit-null"),
        pytest.param({"goal": "New goal"}, {"goal": "New goal"}, id="string"),
    ],
)
def test_update_model_preserves_explicit_goal_only(prepare, options, expected_goal):
    request = MonitorUpdateRequest(
        name="Renamed", retention_days=14, webhook=None, notification=None, **options
    )
    fields_before = request.model_fields_set.copy()

    assert prepare(request) == {"name": "Renamed", "retentionDays": 14, **expected_goal}
    assert request.model_fields_set == fields_before
    assert ("goal" in fields_before) == ("goal" in options)


@pytest.mark.parametrize("prepare", [monitor._prepare_payload, async_monitor._prepare_payload])
def test_create_monitor_still_omits_null_defaults(prepare):
    request = MonitorCreateRequest(
        name="New monitor",
        schedule={"cron": "0 * * * *", "timezone": "UTC"},
        targets=[{"type": "scrape", "url": "https://example.com"}],
        goal=None,
    )
    payload = prepare(request)
    assert "goal" not in payload
    assert "webhook" not in payload
    assert "notification" not in payload
