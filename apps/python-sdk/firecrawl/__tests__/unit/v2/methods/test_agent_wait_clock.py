"""Agent waiting measures elapsed time independently of wall-clock corrections."""

import importlib
import json
from types import SimpleNamespace

import pytest
import requests

from firecrawl.v2.methods.agent import wait_agent


agent_module = importlib.import_module("firecrawl.v2.methods.agent")


class Clock:
    def __init__(self, correction):
        self.elapsed = 0.0
        self.wall = 1_000_000.0
        self.correction = correction
        self.sleeps = []

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.elapsed += seconds
        self.wall += seconds
        if len(self.sleeps) == 1:
            self.wall += self.correction


class StatusClient:
    def __init__(self, statuses, max_calls):
        self.statuses = statuses
        self.max_calls = max_calls
        self.calls = 0

    def get(self, endpoint):
        assert endpoint == "/v2/agent/clock-test"
        self.calls += 1
        assert self.calls <= self.max_calls, "wait continued beyond its elapsed timeout"
        response = requests.Response()
        response.status_code = 200
        response._content = json.dumps({
            "success": True,
            "id": "clock-test",
            "status": self.statuses[min(self.calls - 1, len(self.statuses) - 1)],
        }).encode("utf-8")
        return response


def install_clock(monkeypatch, correction):
    clock = Clock(correction)
    monkeypatch.setattr(agent_module, "time", SimpleNamespace(
        time=lambda: clock.wall,
        monotonic=lambda: clock.elapsed,
        sleep=clock.sleep,
    ))
    return clock


@pytest.mark.parametrize("correction", [-3600, 0, 3600])
def test_wait_timeout_uses_elapsed_time_after_wall_clock_correction(monkeypatch, correction):
    clock = install_clock(monkeypatch, correction)
    client = StatusClient(["processing"], max_calls=5)

    result = wait_agent(client, "clock-test", poll_interval=1, timeout=3)

    assert result.status == "processing"
    assert result.id == "clock-test"
    assert client.calls == 5
    assert clock.sleeps == [1, 1, 1, 1]


@pytest.mark.parametrize("status", ["completed", "failed"])
@pytest.mark.parametrize("timeout", [None, 10])
def test_terminal_result_still_returns_without_another_sleep(monkeypatch, status, timeout):
    clock = install_clock(monkeypatch, -3600)
    client = StatusClient(["processing", status], max_calls=2)

    result = wait_agent(client, "clock-test", poll_interval=1, timeout=timeout)

    assert result.status == status
    assert client.calls == 2
    assert clock.sleeps == [1]
