import asyncio
import json
import time
import pytest

from firecrawl.v2.watcher import Watcher


class DummyHttpClient:
    def __init__(self, api_url: str = "http://localhost", api_key: str = "TEST"):
        self.api_url = api_url
        self.api_key = api_key


class DummyClient:
    def __init__(self):
        self.http_client = DummyHttpClient()


class FakeWebSocket:
    def __init__(self, messages):
        # messages: list of dicts to be json-dumped
        self._messages = list(messages)

    async def recv(self):
        if not self._messages:
            # No more messages; block a bit to allow loop to end
            await asyncio.sleep(0.01)
            # Simulate disconnect
            raise asyncio.CancelledError()
        msg = self._messages.pop(0)
        return json.dumps(msg)


class FakeConnect:
    def __init__(self, ws: FakeWebSocket):
        self._ws = ws

    async def __aenter__(self):
        return self._ws

    async def __aexit__(self, exc_type, exc, tb):
        return False


@pytest.mark.parametrize("kind", ["crawl", "batch"]) 
def test_ws_watcher_document_and_done(monkeypatch, kind):
    # Prepare messages: one document then done
    messages = [
        {"type": "document", "data": {"url": "https://example.com", "rawHtml": "<html>"}},
        {"type": "done", "data": {"status": "completed", "data": []}},
    ]

    ws = FakeWebSocket(messages)

    def fake_connect(uri, *args, **kwargs):
        return FakeConnect(ws)

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    client = DummyClient()
    watcher = Watcher(client, job_id="jid", kind=kind)

    events = {"document": 0, "done": 0}
    statuses = []

    watcher.add_event_listener("document", lambda d: events.__setitem__("document", events["document"] + 1))
    watcher.add_event_listener("done", lambda d: events.__setitem__("done", events["done"] + 1))
    watcher.add_listener(lambda s: statuses.append(s.status))

    watcher.start()

    # Wait for thread to finish
    deadline = time.time() + 2
    while watcher._thread and watcher._thread.is_alive() and time.time() < deadline:
        time.sleep(0.01)

    watcher.stop()

    assert events["document"] >= 1
    assert events["done"] == 1
    assert statuses[-1] in ("completed", "failed", "cancelled")


def test_ws_watcher_error_event(monkeypatch):
    messages = [
        {"type": "error", "error": "boom", "data": {"status": "failed"}},
    ]
    ws = FakeWebSocket(messages)

    def fake_connect(uri, *args, **kwargs):
        return FakeConnect(ws)

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    client = DummyClient()
    watcher = Watcher(client, job_id="jid", kind="crawl")

    seen_error = {"count": 0}
    watcher.add_event_listener("error", lambda d: seen_error.__setitem__("count", seen_error["count"] + 1))

    watcher.start()

    deadline = time.time() + 2
    while watcher._thread and watcher._thread.is_alive() and time.time() < deadline:
        time.sleep(0.01)

    watcher.stop()

    assert seen_error["count"] == 1


@pytest.mark.parametrize("kind", ["crawl", "batch"]) 
def test_ws_watcher_catchup_dispatches_documents_and_updates_status(monkeypatch, kind):
    messages = [
        {
            "type": "catchup",
            "data": {
                "status": "scraping",
                "data": [
                    {"url": "https://example.com/1", "rawHtml": "<html>1</html>"},
                    {"url": "https://example.com/2", "rawHtml": "<html>2</html>"},
                ],
            },
        }
    ]

    ws = FakeWebSocket(messages)

    def fake_connect(uri, *args, **kwargs):
        return FakeConnect(ws)

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    client = DummyClient()
    watcher = Watcher(client, job_id="jid", kind=kind)

    events = {"document": 0}
    statuses = []

    watcher.add_event_listener("document", lambda d: events.__setitem__("document", events["document"] + 1))
    watcher.add_listener(lambda s: statuses.append(s.status))

    watcher.start()

    deadline = time.time() + 2
    while watcher._thread and watcher._thread.is_alive() and time.time() < deadline:
        time.sleep(0.01)

    watcher.stop()

    assert events["document"] == 2
    assert statuses[-1] == "scraping"


@pytest.mark.parametrize("kind", ["crawl", "batch"]) 
def test_ws_watcher_status_only_terminal_snapshot_triggers_done(monkeypatch, kind):
    # No explicit type, only a terminal status snapshot
    messages = [
        {"data": {"status": "completed", "data": []}},
    ]

    ws = FakeWebSocket(messages)

    def fake_connect(uri, *args, **kwargs):
        return FakeConnect(ws)

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    client = DummyClient()
    watcher = Watcher(client, job_id="jid", kind=kind)

    events = {"done": 0}
    statuses = []

    watcher.add_event_listener("done", lambda d: events.__setitem__("done", events["done"] + 1))
    watcher.add_listener(lambda s: statuses.append(s.status))

    watcher.start()

    deadline = time.time() + 2
    while watcher._thread and watcher._thread.is_alive() and time.time() < deadline:
        time.sleep(0.01)

    watcher.stop()

    assert events["done"] == 1
    assert statuses[-1] == "completed"


def test_ws_watcher_batch_cancelled_snapshot_no_done_event(monkeypatch):
    # Batch-only: cancelled snapshot should end without a 'done' event
    messages = [
        {"data": {"status": "cancelled", "data": []}},
    ]

    ws = FakeWebSocket(messages)

    def fake_connect(uri, *args, **kwargs):
        return FakeConnect(ws)

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    client = DummyClient()
    watcher = Watcher(client, job_id="jid", kind="batch")

    events = {"done": 0}
    statuses = []

    watcher.add_event_listener("done", lambda d: events.__setitem__("done", events["done"] + 1))
    watcher.add_listener(lambda s: statuses.append(s.status))

    watcher.start()

    deadline = time.time() + 2
    while watcher._thread and watcher._thread.is_alive() and time.time() < deadline:
        time.sleep(0.01)

    watcher.stop()

    assert events["done"] == 0
    assert statuses[-1] == "cancelled"


def test_ws_watcher_propagates_authorization_header(monkeypatch):
    # Ensure Authorization header is forwarded to websockets.connect
    messages = [
        {"type": "done", "data": {"status": "completed", "data": []}},
    ]

    ws = FakeWebSocket(messages)

    captured_headers = {"headers": None}

    def fake_connect(uri, *args, **kwargs):
        captured_headers["headers"] = kwargs.get("additional_headers")
        return FakeConnect(ws)

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    client = DummyClient()
    watcher = Watcher(client, job_id="jid", kind="crawl")

    watcher.start()

    deadline = time.time() + 2
    while watcher._thread and watcher._thread.is_alive() and time.time() < deadline:
        time.sleep(0.01)

    watcher.stop()

    assert captured_headers["headers"] is not None
    # Expect an Authorization header with Bearer token
    assert any(h[0] == "Authorization" and "Bearer" in h[1] for h in captured_headers["headers"]) 


@pytest.mark.parametrize("kind", ["crawl", "batch"]) 
def test_ws_watcher_normalizes_document_fields_in_snapshot(monkeypatch, kind):
    # Status-only snapshot with camelCase fields should be normalized in emitted job
    messages = [
        {"data": {"status": "completed", "data": [
            {"url": "https://example.com/x", "rawHtml": "<x>", "changeTracking": {"modes": ["git-diff"]}}
        ]}},
    ]

    ws = FakeWebSocket(messages)

    def fake_connect(uri, *args, **kwargs):
        return FakeConnect(ws)

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    client = DummyClient()
    watcher = Watcher(client, job_id="jid", kind=kind)

    jobs = []
    watcher.add_listener(lambda j: jobs.append(j))

    watcher.start()

    deadline = time.time() + 2
    while watcher._thread and watcher._thread.is_alive() and time.time() < deadline:
        time.sleep(0.01)

    watcher.stop()

    assert jobs, "No job snapshots emitted"
    last_job = jobs[-1]
    assert last_job.status == "completed"
    assert last_job.data and last_job.data[0].raw_html == "<x>"
    assert last_job.data[0].change_tracking is not None


@pytest.mark.parametrize("kind", ["crawl", "batch"]) 
def test_ws_watcher_uses_correct_ws_uri(monkeypatch, kind):
    # Verify WS URI uses the correct path per kind and http->ws scheme
    messages = [
        {"type": "done", "data": {"status": "completed", "data": []}},
    ]

    ws = FakeWebSocket(messages)

    captured_uri = {"uri": None}

    def fake_connect(uri, *args, **kwargs):
        captured_uri["uri"] = uri
        return FakeConnect(ws)

    import websockets
    monkeypatch.setattr(websockets, "connect", fake_connect)

    client = DummyClient()
    watcher = Watcher(client, job_id="jid", kind=kind)

    watcher.start()

    deadline = time.time() + 2
    while watcher._thread and watcher._thread.is_alive() and time.time() < deadline:
        time.sleep(0.01)

    watcher.stop()

    assert captured_uri["uri"] is not None
    expected = "ws://localhost/v2/crawl/jid" if kind == "crawl" else "ws://localhost/v2/batch/scrape/jid"
    assert captured_uri["uri"] == expected
