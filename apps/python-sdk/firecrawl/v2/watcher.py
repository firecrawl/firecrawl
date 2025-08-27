"""
WebSocket-based watcher for v2 jobs (crawl and batch), mirroring v1 behavior.

Usage:
    watcher = client.watcher(job_id, kind="crawl")
    watcher.add_listener(lambda status: print(status.status))
    watcher.start()
"""

import asyncio
import json
import threading
from typing import Callable, List, Optional, Literal, Union, Dict, Any

import websockets

from .types import CrawlJob, BatchScrapeJob, Document
from .utils.normalize import normalize_document_input


JobKind = Literal["crawl", "batch"]
JobType = Union[CrawlJob, BatchScrapeJob]


class Watcher:
    def __init__(
        self,
        client: object,
        job_id: str,
        kind: JobKind = "crawl",
        poll_interval: int = 2,
        timeout: Optional[int] = None,
    ) -> None:
        self._client = client
        self._job_id = job_id
        self._kind = kind
        self._timeout = timeout
        self._poll_interval = poll_interval
        self._listeners: List[Callable[[JobType], None]] = []
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

        http_client = getattr(client, "http_client", None)
        self._api_url: Optional[str] = getattr(http_client, "api_url", None)
        self._api_key: Optional[str] = getattr(http_client, "api_key", None)

        # v1-parity state and event handlers
        self.status: str = "scraping"
        self.data: List[Dict[str, Any]] = []
        self._event_handlers: Dict[str, List[Callable[[Dict[str, Any]], None]]] = {
            "done": [],
            "error": [],
            "document": [],
        }
        self._sent_done: bool = False
        self._sent_error: bool = False

    def add_listener(self, callback: Callable[[JobType], None]) -> None:
        self._listeners.append(callback)

    def _emit(self, status: JobType) -> None:
        for cb in list(self._listeners):
            try:
                cb(status)
            except Exception:
                pass

    # v1-like events API
    def add_event_listener(self, event_type: str, handler: Callable[[Dict[str, Any]], None]) -> None:
        if event_type in self._event_handlers:
            self._event_handlers[event_type].append(handler)

    def dispatch_event(self, event_type: str, detail: Dict[str, Any]) -> None:
        if event_type in self._event_handlers:
            for handler in self._event_handlers[event_type]:
                try:
                    handler(detail)
                except Exception:
                    pass

    def _build_ws_url(self) -> str:
        if not self._api_url:
            raise ValueError("API URL is required for WebSocket watcher")
        ws_base = self._api_url.replace("https://", "wss://").replace("http://", "ws://", 1)
        if self._kind == "crawl":
            return f"{ws_base}/v2/crawl/{self._job_id}"
        return f"{ws_base}/v2/batch/scrape/{self._job_id}"

    async def _run_ws(self) -> None:
        uri = self._build_ws_url()
        headers_list = []
        if self._api_key:
            headers_list.append(("Authorization", f"Bearer {self._api_key}"))

        try:
            async with websockets.connect(uri, max_size=None, additional_headers=headers_list) as websocket:
                deadline = asyncio.get_event_loop().time() + self._timeout if self._timeout else None
                while not self._stop.is_set():
                    # Use short recv timeouts to allow HTTP polling fallback
                    if deadline is not None:
                        remaining = max(0.0, deadline - asyncio.get_event_loop().time())
                        timeout = min(self._poll_interval or remaining, remaining)
                    else:
                        timeout = self._poll_interval or 5
                    try:
                        msg = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                    except asyncio.TimeoutError:
                        # Quiet period: poll HTTP once to progress statuses
                        if await self._poll_status_once():
                            break
                        else:
                            continue
                    except asyncio.CancelledError:
                        break
                    except Exception:
                        # Connection error: switch to HTTP polling until terminal or timeout
                        while not self._stop.is_set():
                            if await self._poll_status_once():
                                return
                            if deadline is not None and asyncio.get_event_loop().time() >= deadline:
                                return
                            await asyncio.sleep(self._poll_interval or 2)
                        return

                    try:
                        body = json.loads(msg)
                    except Exception:
                        continue

                    # v1-style typed event handling
                    msg_type = body.get("type")
                    if msg_type == "error":
                        self.status = "failed"
                        self.dispatch_event("error", {
                            "status": self.status,
                            "data": self.data,
                            "error": body.get("error"),
                            "id": self._job_id,
                        })
                        self._sent_error = True
                        # Emit a final failed snapshot for listeners
                        if self._kind == "crawl":
                            job = CrawlJob(status="failed", completed=0, total=0, credits_used=0, expires_at=None, next=None, data=[])
                        else:
                            job = BatchScrapeJob(status="failed", completed=0, total=0, credits_used=0, expires_at=None, next=None, data=[])
                        self._emit(job)
                        break
                    elif msg_type == "catchup":
                        d = body.get("data", {})
                        self.status = d.get("status", self.status)
                        docs_in = d.get("data", [])
                        self.data.extend(docs_in)
                        for doc in docs_in:
                            self.dispatch_event("document", {"data": doc, "id": self._job_id})
                    elif msg_type == "document":
                        doc = body.get("data")
                        if isinstance(doc, dict):
                            self.data.append(doc)
                            self.dispatch_event("document", {"data": doc, "id": self._job_id})
                    elif msg_type == "done":
                        self.status = "completed"
                        # Gather any documents in the done payload
                        raw_payload = body.get("data", {}) or {}
                        docs_in = raw_payload.get("data", []) or []
                        if isinstance(docs_in, list) and docs_in:
                            for doc in docs_in:
                                if isinstance(doc, dict):
                                    self.data.append(doc)
                        # Dispatch done event first
                        self.dispatch_event("done", {"status": self.status, "data": self.data, "id": self._job_id})
                        self._sent_done = True
                        # Emit a final completed snapshot for listeners and break immediately
                        docs: List[Document] = []
                        for doc in self.data:
                            if isinstance(doc, dict):
                                d = normalize_document_input(doc)
                                docs.append(Document(**d))
                        if self._kind == "crawl":
                            job = CrawlJob(
                                status="completed",
                                completed=raw_payload.get("completed", 0),
                                total=raw_payload.get("total", 0),
                                credits_used=raw_payload.get("creditsUsed", 0),
                                expires_at=raw_payload.get("expiresAt"),
                                next=raw_payload.get("next"),
                                data=docs,
                            )
                        else:
                            job = BatchScrapeJob(
                                status="completed",
                                completed=raw_payload.get("completed", 0),
                                total=raw_payload.get("total", 0),
                                credits_used=raw_payload.get("creditsUsed", 0),
                                expires_at=raw_payload.get("expiresAt"),
                                next=raw_payload.get("next"),
                                data=docs,
                            )
                        self._emit(job)
                        break

                    payload = body.get("data", body)
                    # Only treat messages with an explicit status as job snapshots
                    has_status_field = (isinstance(payload, dict) and "status" in payload) or ("status" in body)
                    if not has_status_field:
                        continue
                    status_str = payload.get("status", body.get("status", self.status))

                    if self._kind == "crawl":
                        docs = []
                        for doc in payload.get("data", []):
                            if isinstance(doc, dict):
                                d = normalize_document_input(doc)
                                docs.append(Document(**d))
                        job = CrawlJob(
                            status=status_str,
                            completed=payload.get("completed", 0),
                            total=payload.get("total", 0),
                            credits_used=payload.get("creditsUsed", 0),
                            expires_at=payload.get("expiresAt"),
                            next=payload.get("next"),
                            data=docs,
                        )
                        self._emit(job)
                        if status_str in ("completed", "failed", "cancelled"):
                            # Ensure done/error dispatched even if server didn't send explicit event type
                            if status_str == "completed" and not self._sent_done:
                                self.dispatch_event("done", {"status": status_str, "data": self.data, "id": self._job_id})
                                self._sent_done = True
                            if status_str == "failed" and not self._sent_error:
                                self.dispatch_event("error", {"status": status_str, "data": self.data, "id": self._job_id})
                                self._sent_error = True
                            break
                    else:
                        docs = []
                        for doc in payload.get("data", []):
                            if isinstance(doc, dict):
                                d = normalize_document_input(doc)
                                docs.append(Document(**d))
                        job = BatchScrapeJob(
                            status=status_str,
                            completed=payload.get("completed", 0),
                            total=payload.get("total", 0),
                            credits_used=payload.get("creditsUsed"),
                            expires_at=payload.get("expiresAt"),
                            next=payload.get("next"),
                            data=docs,
                        )
                        self._emit(job)
                        if status_str in ("completed", "failed", "cancelled"):
                            if status_str == "completed" and not self._sent_done:
                                self.dispatch_event("done", {"status": status_str, "data": self.data, "id": self._job_id})
                                self._sent_done = True
                            if status_str == "failed" and not self._sent_error:
                                self.dispatch_event("error", {"status": status_str, "data": self.data, "id": self._job_id})
                                self._sent_error = True
                            break
        except Exception:
            pass
        finally:
            # Ensure terminal event parity with v1 even on abrupt disconnects
            if self.status == "completed" and not self._sent_done:
                self.dispatch_event("done", {"status": self.status, "data": self.data, "id": self._job_id})
                self._sent_done = True

    async def _poll_status_once(self) -> bool:
        """Poll job status over HTTP once. Returns True if terminal."""
        try:
            if self._kind == "crawl":
                job: CrawlJob = await asyncio.to_thread(self._client.get_crawl_status, self._job_id)
            else:
                job: BatchScrapeJob = await asyncio.to_thread(self._client.get_batch_scrape_status, self._job_id)
        except Exception:
            return False

        self.status = job.status
        self._emit(job)
        if job.status in ("completed", "failed", "cancelled"):
            if job.status == "completed" and not self._sent_done:
                self.dispatch_event("done", {"status": job.status, "data": [d.model_dump() for d in job.data], "id": self._job_id})
                self._sent_done = True
            if job.status == "failed" and not self._sent_error:
                self.dispatch_event("error", {"status": job.status, "data": [d.model_dump() for d in job.data], "id": self._job_id})
                self._sent_error = True
            return True
        return False

    def _loop(self) -> None:
        asyncio.run(self._run_ws())

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)

