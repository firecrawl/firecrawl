"""
Async WebSocket watcher with async iterator interface for v2 jobs.

Usage:
    async for snapshot in AsyncWatcher(client, job_id, kind="crawl"):
        print(snapshot.status)
"""

import asyncio
import inspect
import json
import time
from typing import AsyncIterator, Dict, List, Literal, Optional

import websockets
from websockets.exceptions import ConnectionClosed, ConnectionClosedOK, ConnectionClosedError

from .types import BatchScrapeJob, CrawlJob, Document
from .utils.normalize import normalize_document_input

JobKind = Literal["crawl", "batch"]


class AsyncWatcher:
    def __init__(
        self,
        client: object,
        job_id: str,
        *,
        kind: JobKind = "crawl",
        timeout: Optional[int] = None,
    ) -> None:
        self._client = client
        self._job_id = job_id
        self._kind = kind
        self._timeout = timeout
        self._poll_interval: float = 2.0

        http_client = getattr(client, "http_client", None)
        if http_client is not None:
            self._api_url = getattr(http_client, "api_url", None)
            self._api_key = getattr(http_client, "api_key", None)
        else:
            # Allow passing the top-level Firecrawl client directly
            self._api_url = getattr(client, "api_url", None)
            self._api_key = getattr(client, "api_key", None)

        self._status: str = "scraping"
        self._data: List[Dict] = []

    def __aiter__(self) -> AsyncIterator[object]:
        return self._iterate()

    def _build_ws_url(self) -> str:
        if not self._api_url:
            raise ValueError("API URL is required for WebSocket watcher")
        ws_base = self._api_url.replace("https://", "wss://").replace("http://", "ws://", 1)
        if self._kind == "crawl":
            return f"{ws_base}/v2/crawl/{self._job_id}"
        return f"{ws_base}/v2/batch/scrape/{self._job_id}"

    async def _iterate(self) -> AsyncIterator[object]:
        uri = self._build_ws_url()
        headers_list = []
        if self._api_key:
            headers_list.append(("Authorization", f"Bearer {self._api_key}"))

        # Attempt to establish WS; on failure, fall back to HTTP polling immediately
        try:
            async with websockets.connect(uri, max_size=None, additional_headers=headers_list) as websocket:
                deadline = asyncio.get_event_loop().time() + self._timeout if self._timeout else None
                # Pre-yield a snapshot if available to ensure progress is visible
                try:
                    pre = await self._fetch_job_status()
                    yield pre
                    if pre.status in ("completed", "failed", "cancelled"):
                        return
                except Exception:
                    pass

                while True:
                    try:
                        if deadline is not None:
                            remaining = max(0.0, deadline - asyncio.get_event_loop().time())
                            timeout = min(self._poll_interval, remaining) if remaining > 0 else 0.0
                        else:
                            timeout = self._poll_interval
                        msg = await asyncio.wait_for(websocket.recv(), timeout=timeout)
                    except asyncio.TimeoutError:
                        # Quiet period: poll HTTP once
                        job = await self._safe_fetch()
                        if job is not None:
                            yield job
                            if job.status in ("completed", "failed", "cancelled"):
                                return
                        if deadline is not None and asyncio.get_event_loop().time() >= deadline:
                            return
                        continue
                    except (ConnectionClosedOK, ConnectionClosed, ConnectionClosedError):
                        # Graceful/abrupt close: poll HTTP until terminal (bounded by timeout)
                        deadline = time.time() + (self._timeout or 30)
                        while True:
                            try:
                                job = await self._fetch_job_status()
                                yield job
                                if job.status in ("completed", "failed", "cancelled"):
                                    return
                            except Exception:
                                return
                            if time.time() >= deadline:
                                return
                            await asyncio.sleep(1)
                    try:
                        body = json.loads(msg)
                    except Exception:
                        continue

                    msg_type = body.get("type")
                    if msg_type == "error":
                        self._status = "failed"
                        # Yield a terminal snapshot
                        if self._kind == "crawl":
                            yield CrawlJob(status="failed", completed=0, total=0, credits_used=0, expires_at=None, next=None, data=[])
                        else:
                            yield BatchScrapeJob(status="failed", completed=0, total=0, credits_used=0, expires_at=None, next=None, data=[])
                        return
                    elif msg_type == "catchup":
                        d = body.get("data", {})
                        self._status = d.get("status", self._status)
                        docs_in = d.get("data", []) or []
                        self._data.extend(docs_in)
                        # Fall through to emit a snapshot below
                    elif msg_type == "document":
                        doc = body.get("data")
                        if isinstance(doc, dict):
                            self._data.append(doc)
                        # Fall through to emit a snapshot below
                    elif msg_type == "done":
                        self._status = "completed"
                        raw_payload = body.get("data", {}) or {}
                        docs_in = raw_payload.get("data", []) or []
                        if isinstance(docs_in, list) and docs_in:
                            for doc in docs_in:
                                if isinstance(doc, dict):
                                    self._data.append(doc)
                        # Emit final snapshot then end
                        yield self._make_snapshot(status="completed", payload=raw_payload, docs_override=self._data)
                        return

                    # Generic snapshot emit for status messages and periodic progress
                    payload = body.get("data", body)
                    status_str = payload.get("status", body.get("status", self._status))
                    snapshot = self._make_snapshot(status=status_str, payload=payload)
                    yield snapshot
                    if status_str in ("completed", "failed", "cancelled"):
                        return
        except Exception:
            # WS connect failure: fallback to HTTP polling loop until terminal/timeout
            deadline = time.time() + (self._timeout or 30)
            while True:
                try:
                    job = await self._fetch_job_status()
                    yield job
                    if job.status in ("completed", "failed", "cancelled"):
                        return
                except Exception:
                    return
                if time.time() >= deadline:
                    return
                await asyncio.sleep(1)

    async def _fetch_job_status(self):
        if self._kind == "crawl":
            return await self._call_status_method("get_crawl_status")
        return await self._call_status_method("get_batch_scrape_status")

    async def _call_status_method(self, method_name: str):
        # Try on client directly
        meth = getattr(self._client, method_name, None)
        if meth is not None:
            try:
                result = meth(self._job_id)
            except TypeError:
                result = None
            if result is not None:
                if inspect.isawaitable(result):
                    return await result
                return result
            # Fallback: if we couldn't call directly, try to_thread
            return await asyncio.to_thread(meth, self._job_id)

        # Try on client.v2
        v2 = getattr(self._client, "v2", None)
        if v2 is not None:
            meth = getattr(v2, method_name, None)
            if meth is not None:
                try:
                    result = meth(self._job_id)
                except TypeError:
                    result = None
                if result is not None:
                    if inspect.isawaitable(result):
                        return await result
                    return result
                return await asyncio.to_thread(meth, self._job_id)

        raise RuntimeError(f"Client does not expose {method_name}")

    async def _safe_fetch(self):
        try:
            return await self._fetch_job_status()
        except Exception:
            return None

    def _make_snapshot(self, *, status: str, payload: Dict, docs_override: Optional[List[Dict]] = None):
        docs = []
        source_docs = docs_override if docs_override is not None else payload.get("data", []) or []
        for doc in source_docs:
            if isinstance(doc, dict):
                d = normalize_document_input(doc)
                docs.append(Document(**d))

        if self._kind == "crawl":
            return CrawlJob(
                status=status,
                completed=payload.get("completed", 0),
                total=payload.get("total", 0),
                credits_used=payload.get("creditsUsed", 0),
                expires_at=payload.get("expiresAt"),
                next=payload.get("next"),
                data=docs,
            )
        return BatchScrapeJob(
            status=status,
            completed=payload.get("completed", 0),
            total=payload.get("total", 0),
            credits_used=payload.get("creditsUsed"),
            expires_at=payload.get("expiresAt"),
            next=payload.get("next"),
            data=docs,
        )

