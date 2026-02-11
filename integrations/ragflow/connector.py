"""
Firecrawl data-source connector for RAGFlow.

Implements RAGFlow's LoadConnector / PollConnector interfaces so that
Firecrawl can appear as a first-class data source inside RAGFlow.

Usage inside RAGFlow
--------------------
Register this connector in RAGFlow's connector registry (see README for
details).  RAGFlow will call:

    connector.load_credentials({"firecrawl_api_key": "fc-..."})
    for doc_batch in connector.load_from_state():
        # each batch is a list[Document]
        ...
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, Generator, List, Optional
from urllib.parse import urlparse

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .config import FirecrawlSourceConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lightweight stand-ins for RAGFlow model types so the module can be used
# both *inside* RAGFlow (where the real classes are importable) and
# *outside* for testing / standalone usage.
# When running inside RAGFlow the caller can monkey-patch or the imports
# below will resolve from the RAGFlow package path.
# ---------------------------------------------------------------------------
try:
    from common.data_source.models import Document, TextSection
    from common.data_source.interfaces import LoadConnector, PollConnector, SecondsSinceUnixEpoch
except ImportError:
    # Fallback dataclasses so the file is importable standalone.
    from dataclasses import dataclass, field as dc_field

    SecondsSinceUnixEpoch = float  # type: ignore[misc]

    @dataclass
    class TextSection:  # type: ignore[no-redef]
        link: str = ""
        text: str = ""

    @dataclass
    class Document:  # type: ignore[no-redef]
        id: str = ""
        source: str = "firecrawl"
        semantic_identifier: str = ""
        extension: str = ".html"
        blob: bytes = b""
        doc_updated_at: datetime = dc_field(default_factory=lambda: datetime.now(timezone.utc))
        size_bytes: int = 0
        metadata: Optional[Dict[str, Any]] = None
        sections: Optional[list] = None

    class LoadConnector:  # type: ignore[no-redef]
        def load_credentials(self, credentials: Dict[str, Any]) -> Dict[str, Any] | None:
            raise NotImplementedError

        def load_from_state(self) -> Generator[list, None, None]:
            raise NotImplementedError

    class PollConnector:  # type: ignore[no-redef]
        def poll_source(self, start: float, end: float) -> Generator[list, None, None]:
            raise NotImplementedError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_BATCH_SIZE = 10  # how many Documents to yield per batch


def _doc_id(url: str) -> str:
    """Deterministic document id from URL."""
    return hashlib.sha256(url.encode()).hexdigest()[:20]


def _extract_title(markdown: str, metadata: Dict[str, Any], url: str) -> str:
    """Best-effort title extraction."""
    if metadata.get("title"):
        return metadata["title"]
    m = re.search(r"^#\s+(.+)$", markdown, re.MULTILINE)
    if m:
        return m.group(1).strip()
    return urlparse(url).path.rstrip("/").split("/")[-1] or url


def _build_session(config: FirecrawlSourceConfig) -> requests.Session:
    """Build a requests.Session with retry + auth headers."""
    session = requests.Session()
    session.headers.update(
        {
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json",
        }
    )
    retry = Retry(
        total=config.max_retries,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"],
    )
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.mount("http://", HTTPAdapter(max_retries=retry))
    return session


# ---------------------------------------------------------------------------
# Connector
# ---------------------------------------------------------------------------


class FirecrawlConnector(LoadConnector, PollConnector):
    """RAGFlow data-source connector backed by the Firecrawl API.

    Supports two modes controlled by ``FirecrawlSourceConfig.mode``:

    * **scrape** – scrape a list of individual URLs.
    * **crawl** – start a Firecrawl crawl job from a seed URL and poll
      until it finishes, then yield all discovered pages.
    """

    def __init__(self, config: FirecrawlSourceConfig | None = None, **kwargs: Any):
        self.config = config or FirecrawlSourceConfig(**kwargs)
        self._session: Optional[requests.Session] = None

    # -- RAGFlow interface: credentials -------------------------------------

    def load_credentials(self, credentials: Dict[str, Any]) -> Dict[str, Any] | None:
        """Accept credentials dict from RAGFlow and configure the connector."""
        api_key = credentials.get("firecrawl_api_key", "")
        if api_key:
            self.config.api_key = api_key
        api_url = credentials.get("firecrawl_api_url")
        if api_url:
            self.config.api_url = api_url
        return None

    # -- RAGFlow interface: LoadConnector ------------------------------------

    def load_from_state(self) -> Generator[list[Document], None, None]:
        """Yield batches of Documents from Firecrawl."""
        errors = self.config.validate()
        if errors:
            raise ValueError(f"Invalid Firecrawl config: {'; '.join(errors)}")

        self._session = _build_session(self.config)

        try:
            if self.config.mode == "crawl":
                yield from self._crawl()
            else:
                yield from self._scrape_urls(self.config.urls)
        finally:
            self._session.close()
            self._session = None

    # -- RAGFlow interface: PollConnector ------------------------------------

    def poll_source(
        self,
        start: SecondsSinceUnixEpoch,
        end: SecondsSinceUnixEpoch,
    ) -> Generator[list[Document], None, None]:
        """Re-scrape the configured URLs (poll-based refresh)."""
        yield from self.load_from_state()

    # -- internal: scrape ----------------------------------------------------

    def _scrape_urls(self, urls: List[str]) -> Generator[list[Document], None, None]:
        batch: list[Document] = []
        for url in urls:
            doc = self._scrape_single(url)
            if doc is not None:
                batch.append(doc)
            if len(batch) >= _BATCH_SIZE:
                yield batch
                batch = []
            # polite delay
            time.sleep(self.config.rate_limit_delay)
        if batch:
            yield batch

    def _scrape_single(self, url: str) -> Optional[Document]:
        """Scrape one URL via the Firecrawl /v2/scrape endpoint."""
        assert self._session is not None
        payload: Dict[str, Any] = {
            "url": url,
            "formats": self.config.formats,
        }
        if self.config.exclude_tags:
            payload["excludeTags"] = self.config.exclude_tags

        try:
            resp = self._session.post(
                f"{self.config.api_url}/v2/scrape",
                json=payload,
                timeout=self.config.timeout,
            )
            if resp.status_code == 429:
                logger.warning("Rate-limited by Firecrawl, backing off 5 s")
                time.sleep(5)
                resp = self._session.post(
                    f"{self.config.api_url}/v2/scrape",
                    json=payload,
                    timeout=self.config.timeout,
                )
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.error("Firecrawl scrape failed for %s: %s", url, exc)
            return None

        body = resp.json()
        if not body.get("success"):
            logger.warning("Firecrawl returned success=false for %s: %s", url, body.get("error"))
            return None

        return self._response_to_document(body.get("data", {}), url)

    # -- internal: crawl -----------------------------------------------------

    def _crawl(self) -> Generator[list[Document], None, None]:
        """Start a crawl job and poll until complete, then yield docs."""
        assert self._session is not None
        seed_url = self.config.urls[0] if self.config.urls else ""
        if not seed_url:
            logger.error("No seed URL provided for crawl mode")
            return

        # Start crawl job
        payload: Dict[str, Any] = {
            "url": seed_url,
            "limit": self.config.crawl_limit,
            "scrapeOptions": {"formats": self.config.formats},
        }
        if self.config.exclude_tags:
            payload["scrapeOptions"]["excludeTags"] = self.config.exclude_tags

        try:
            resp = self._session.post(
                f"{self.config.api_url}/v2/crawl",
                json=payload,
                timeout=self.config.timeout,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.error("Failed to start Firecrawl crawl: %s", exc)
            return

        body = resp.json()
        if not body.get("success"):
            logger.error("Firecrawl crawl start failed: %s", body.get("error"))
            return

        job_id = body.get("id")
        if not job_id:
            logger.error("No job id returned from Firecrawl crawl")
            return

        logger.info("Firecrawl crawl started, job_id=%s", job_id)

        # Poll until done
        while True:
            time.sleep(10)
            try:
                status_resp = self._session.get(
                    f"{self.config.api_url}/v2/crawl/{job_id}",
                    timeout=self.config.timeout,
                )
                status_resp.raise_for_status()
            except requests.RequestException as exc:
                logger.error("Failed to poll crawl status: %s", exc)
                return

            status_body = status_resp.json()
            status = status_body.get("status", "unknown")
            logger.info("Crawl %s status: %s", job_id, status)

            if status == "completed":
                data_items = status_body.get("data", [])
                yield from self._items_to_batches(data_items)
                return
            elif status in ("failed", "cancelled"):
                logger.error("Crawl %s ended with status %s", job_id, status)
                return
            # else keep polling

    # -- internal: conversion ------------------------------------------------

    def _items_to_batches(self, items: List[Dict[str, Any]]) -> Generator[list[Document], None, None]:
        batch: list[Document] = []
        for item in items:
            doc = self._response_to_document(item, item.get("metadata", {}).get("sourceURL", ""))
            if doc is not None:
                batch.append(doc)
            if len(batch) >= _BATCH_SIZE:
                yield batch
                batch = []
        if batch:
            yield batch

    def _response_to_document(self, data: Dict[str, Any], fallback_url: str) -> Optional[Document]:
        """Convert a Firecrawl response data dict into a RAGFlow Document."""
        metadata = data.get("metadata", {})
        url = metadata.get("sourceURL", fallback_url)
        markdown = data.get("markdown", "")
        html = data.get("html", "")
        content = markdown or html
        if not content:
            logger.debug("No content for %s, skipping", url)
            return None

        title = _extract_title(markdown, metadata, url)
        content_bytes = content.encode("utf-8")

        doc = Document(
            id=_doc_id(url),
            source="firecrawl",
            semantic_identifier=title,
            extension=".md" if markdown else ".html",
            blob=content_bytes,
            doc_updated_at=datetime.now(timezone.utc),
            size_bytes=len(content_bytes),
            metadata={
                "url": url,
                "title": metadata.get("title", ""),
                "description": metadata.get("description", ""),
                "language": metadata.get("language", ""),
                "status_code": metadata.get("statusCode"),
                "domain": urlparse(url).netloc,
            },
        )
        return doc
