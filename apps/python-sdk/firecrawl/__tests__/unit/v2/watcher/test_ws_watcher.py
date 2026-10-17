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


@pytest.mark.parametrize("kind", ["crawl", "batch"])
@pytest.mark.parametrize("async_mode", [False, True])
def test_document_progress_snapshots_keep_accumulated_documents(monkeypatch, kind, async_mode):
    from firecrawl.v2.watcher_async import AsyncWatcher

    messages = [
        {"type": "catchup", "data": {"status": "scraping", "completed": 1,
         "total": 3, "creditsUsed": 3, "data": [{"markdown": "existing"}]}},
        {"type": "document", "data": {"markdown": "new first"}},
        {"type": "document", "data": {"markdown": "new second"}},
        {"type": "done"},
    ]
    import websockets
    monkeypatch.setattr(websockets, "connect", lambda *args, **kwargs: FakeConnect(FakeWebSocket(messages)))

    snapshots = []
    if async_mode:
        async def consume():
            async for snapshot in AsyncWatcher(DummyClient(), "jid", kind=kind):
                snapshots.append(snapshot)
        asyncio.run(consume())
    else:
        watcher = Watcher(DummyClient(), "jid", kind=kind)
        watcher.add_listener(snapshots.append)
        asyncio.run(watcher._run_ws())

    assert [doc.markdown for doc in snapshots[0].data] == ["existing"]
    if async_mode:
        assert [doc.markdown for doc in snapshots[1].data] == ["existing", "new first"]
        assert [doc.markdown for doc in snapshots[2].data] == ["existing", "new first", "new second"]
    else:
        assert len(snapshots) == 2  # Sync document delivery uses event listeners.
    assert [doc.markdown for doc in snapshots[-1].data] == ["existing", "new first", "new second"]
    # Previously yielded snapshots are stable as new events arrive.
    assert len(snapshots[0].data) == 1


def test_async_status_frame_preserves_its_document_payload(monkeypatch):
    from firecrawl.v2.watcher_async import AsyncWatcher
    import websockets

    message = {"status": "completed", "completed": 1, "total": 1,
               "creditsUsed": 1, "data": [{"markdown": "status result"}]}
    monkeypatch.setattr(websockets, "connect", lambda *args, **kwargs: FakeConnect(FakeWebSocket([{"type": "status", "data": message}])))

    async def consume():
        return [snapshot async for snapshot in AsyncWatcher(DummyClient(), "jid")]

    snapshots = asyncio.run(consume())
    assert [doc.markdown for doc in snapshots[0].data] == ["status result"]


@pytest.mark.parametrize("kind", ["crawl", "batch"])
@pytest.mark.parametrize("document_count", [8, 64])
def test_async_progress_validates_only_new_documents(monkeypatch, kind, document_count):
    from firecrawl.v2 import watcher_async

    calls = {"normalize": 0, "validate": 0}
    normalize = watcher_async.normalize_document_input
    document = watcher_async.Document

    def counted_normalize(raw):
        calls["normalize"] += 1
        return normalize(raw)

    def counted_document(**values):
        calls["validate"] += 1
        return document(**values)

    monkeypatch.setattr(watcher_async, "normalize_document_input", counted_normalize)
    monkeypatch.setattr(watcher_async, "Document", counted_document)
    messages = [{"type": "document", "data": {"markdown": str(i)}}
                for i in range(document_count)]
    messages.append({"type": "done", "data": {"data": [{"markdown": "final"}]}})
    import websockets
    monkeypatch.setattr(websockets, "connect", lambda *a, **kw: FakeConnect(FakeWebSocket(messages)))

    async def consume():
        return [s async for s in watcher_async.AsyncWatcher(DummyClient(), "jid", kind=kind)]

    snapshots = asyncio.run(consume())
    assert len(snapshots) == document_count + 1
    assert [len(s.data) for s in snapshots] == list(range(1, document_count + 2))
    assert [d.markdown for d in snapshots[-1].data] == [str(i) for i in range(document_count)] + ["final"]
    assert calls == {"normalize": document_count + 1, "validate": document_count + 1}


@pytest.mark.parametrize("kind", ["crawl", "batch"])
def test_async_cached_documents_are_independent_nested_snapshots(monkeypatch, kind):
    from firecrawl.v2.watcher_async import AsyncWatcher
    import websockets

    messages = [
        {"type": "catchup", "data": {"status": "scraping", "data": [None, {
            "markdown": "original", "rawHtml": "<original>",
            "metadata": {"sourceURL": "https://example.com", "custom": {"tags": ["original"]}},
            "json": {"values": ["original"]}, "links": ["https://example.com"],
        }]}},
        {"type": "document", "data": {"markdown": "second"}},
        {"type": "done", "data": {"completed": 2, "total": 2, "creditsUsed": 2}},
    ]
    monkeypatch.setattr(websockets, "connect", lambda *a, **kw: FakeConnect(FakeWebSocket(messages)))

    async def consume():
        iterator = AsyncWatcher(DummyClient(), "jid", kind=kind).__aiter__()
        first = await iterator.__anext__()
        first.data[0].markdown = "mutated"
        first.data[0].metadata.custom["tags"].append("mutated")
        first.data[0].json["values"].append("mutated")
        first.data[0].links.clear()
        second = await iterator.__anext__()
        first.data.clear()
        final = await iterator.__anext__()
        second.data[0].json["values"].clear()
        return second, final

    second, final = asyncio.run(consume())
    assert len(second.data) == len(final.data) == 2
    for snapshot in (second, final):
        assert snapshot.data[0].markdown == "original"
        assert snapshot.data[0].raw_html == "<original>"
        assert snapshot.data[0].metadata.source_url == "https://example.com"
        assert snapshot.data[0].metadata.custom == {"tags": ["original"]}
        assert snapshot.data[0].links == ["https://example.com"]
    assert final.data[0].json == {"values": ["original"]}
    assert final.status == "completed"
    assert final.completed == final.total == final.credits_used == 2


@pytest.mark.parametrize("kind", ["crawl", "batch"])
def test_async_progress_cache_over_real_websocket(monkeypatch, kind):
    from firecrawl.v2 import watcher_async
    from websockets.asyncio.server import serve

    normalized = []
    normalize = watcher_async.normalize_document_input

    def counted_normalize(doc):
        normalized.append(doc["markdown"])
        return normalize(doc)

    monkeypatch.setattr(watcher_async, "normalize_document_input", counted_normalize)

    async def stream(websocket):
        await websocket.send(json.dumps({"type": "catchup", "data": {
            "status": "scraping", "data": [{"markdown": "catchup", "json": {"items": [1]}}]}}))
        for index in range(16):
            await websocket.send(json.dumps({"type": "document", "data": {"markdown": str(index)}}))
        await websocket.send(json.dumps({"type": "done", "data": {"status": "completed"}}))
        await websocket.wait_closed()

    async def consume():
        async with serve(stream, "127.0.0.1", 0) as server:
            client = DummyClient()
            port = server.sockets[0].getsockname()[1]
            client.http_client.api_url = "http://127.0.0.1:{}".format(port)
            snapshots = []
            async for snapshot in watcher_async.AsyncWatcher(client, "jid", kind=kind):
                snapshots.append(snapshot)
                if len(snapshots) == 1:
                    snapshot.data[0].json["items"].append(2)
            return snapshots

    snapshots = asyncio.run(consume())
    assert len(snapshots) == 18
    assert [len(s.data) for s in snapshots] == [1] + list(range(2, 18)) + [17]
    assert snapshots[-1].status == "completed"
    assert normalized == ["catchup"] + [str(i) for i in range(16)]
    assert snapshots[-1].data[0].json == {"items": [1]}
    assert snapshots[0].data[0].json == {"items": [1, 2]}
