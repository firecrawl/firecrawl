"""
Qdrant integration for Firecrawl: deduplication-aware vector storage for crawl jobs.

Usage example::

    from firecrawl import Firecrawl
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams

    fc = Firecrawl(api_key="...")
    qc = QdrantClient(url="http://localhost:6333")

    qc.recreate_collection(
        "my_docs",
        vectors_config=VectorParams(size=1536, distance=Distance.COSINE),
    )

    def embed(text: str) -> list[float]:
        # plug in any embedding provider
        import openai
        resp = openai.embeddings.create(input=[text], model="text-embedding-3-small")
        return resp.data[0].embedding

    result = fc.crawl_to_store(
        "https://docs.example.com",
        qdrant_client=qc,
        collection_name="my_docs",
        embedding_fn=embed,
        skip_existing=True,
        limit=50,
    )
    print(f"Crawled {result.total} pages — {result.upserted} upserted, {result.skipped} skipped")
"""

from __future__ import annotations

import hashlib
import uuid
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Callable, Dict, List, Optional, Tuple

if TYPE_CHECKING:
    from ..types import CrawlJob, Document

logger = logging.getLogger("firecrawl")

# Number of points sent to Qdrant in a single upsert call.
_DEFAULT_BATCH_SIZE = 100


@dataclass
class CrawlToStoreResult:
    """Result of a ``crawl_to_store`` operation.

    Attributes:
        total:      Total pages returned by the crawl.
        upserted:   Pages inserted or updated in Qdrant.
        skipped:    Pages not upserted — either because an identical copy
                    already existed in Qdrant (``skip_existing=True``) or
                    because the document had no usable content for the chosen
                    ``content_key``.
        updated:    Subset of *upserted* pages where content changed since the
                    last crawl (existing point was overwritten).
        crawl_job:  The completed :class:`~firecrawl.v2.types.CrawlJob`.
        errors:     Per-page errors encountered during embedding or upsert
                    (url → error message).  Pages with errors are not counted
                    in *upserted* or *skipped*.
    """

    total: int
    upserted: int
    skipped: int
    updated: int
    crawl_job: "CrawlJob"
    errors: Dict[str, str] = field(default_factory=dict)


def _content_hash(text: str) -> str:
    """Return a hex SHA-256 digest of *text*."""
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _url_for_doc(doc: "Document") -> Optional[str]:
    """Extract the canonical URL from a Document."""
    if doc.metadata:
        return doc.metadata.url or doc.metadata.source_url
    return None


def _get_content(doc: "Document", content_key: str) -> Optional[str]:
    """Return the text content to embed/hash from *doc* using *content_key*."""
    return getattr(doc, content_key, None)


def _doc_to_payload(doc: "Document", content_key: str, content_hash: str) -> Dict[str, Any]:
    """Build the Qdrant point payload for *doc*."""
    payload: Dict[str, Any] = {
        "content_hash": content_hash,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
    }

    url = _url_for_doc(doc)
    if url:
        payload["url"] = url

    content = _get_content(doc, content_key)
    if content:
        payload["content"] = content

    if doc.metadata:
        if doc.metadata.title:
            payload["title"] = doc.metadata.title
        if doc.metadata.description:
            payload["description"] = doc.metadata.description

    return payload


def _url_to_point_id(url: str) -> str:
    """Derive a deterministic UUID from a URL so re-crawls update in-place."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, url))


def _retrieve_existing_point(qdrant_client: Any, collection_name: str, point_id: str):
    """
    Fetch a single point by its deterministic *point_id* from Qdrant.

    Uses ``retrieve()`` (a direct O(1) key lookup) rather than a payload
    filter scroll, so no payload index on ``url`` is required.

    Returns the point record or ``None`` if not found.
    """
    results = qdrant_client.retrieve(
        collection_name=collection_name,
        ids=[point_id],
        with_payload=True,
        with_vectors=False,
    )
    return results[0] if results else None


def _flush_batch(
    qdrant_client: Any,
    collection_name: str,
    batch: List[Any],  # List[PointStruct]
    batch_meta: List[Tuple[str, bool]],  # (url, is_update) per point
    errors: Dict[str, str],
) -> Tuple[int, int]:
    """
    Upsert *batch* into Qdrant and return ``(upserted_count, updated_count)``.

    On batch failure every URL in the batch is individually retried so that a
    single bad document does not silently discard the rest.  Per-URL errors are
    recorded in *errors*.
    """
    if not batch:
        return 0, 0

    try:
        qdrant_client.upsert(collection_name=collection_name, points=batch)
        upserted = len(batch)
        updated = sum(1 for _, is_upd in batch_meta if is_upd)
        return upserted, updated
    except Exception as batch_exc:
        logger.warning(
            "Batch upsert failed (%s), retrying individually: %s",
            collection_name,
            batch_exc,
        )

    upserted = updated = 0
    for point, (url, is_update) in zip(batch, batch_meta):
        try:
            qdrant_client.upsert(collection_name=collection_name, points=[point])
            upserted += 1
            if is_update:
                updated += 1
        except Exception as exc:
            msg = f"Qdrant upsert failed: {exc}"
            logger.warning("%s (url=%s)", msg, url)
            if url:
                errors[url] = msg

    return upserted, updated


def crawl_to_store(
    firecrawl_client: Any,
    url: str,
    *,
    qdrant_client: Any,
    collection_name: str,
    embedding_fn: Callable[[str], List[float]],
    skip_existing: bool = True,
    content_key: str = "markdown",
    batch_size: int = _DEFAULT_BATCH_SIZE,
    # ---- crawl kwargs forwarded verbatim ----
    prompt: Optional[str] = None,
    exclude_paths: Optional[List[str]] = None,
    include_paths: Optional[List[str]] = None,
    max_discovery_depth: Optional[int] = None,
    ignore_query_parameters: bool = False,
    limit: Optional[int] = None,
    crawl_entire_domain: bool = False,
    allow_external_links: bool = False,
    allow_subdomains: bool = False,
    ignore_robots_txt: bool = False,
    delay: Optional[int] = None,
    max_concurrency: Optional[int] = None,
    scrape_options: Optional[Any] = None,
    deduplicate_similar_urls: bool = True,
    zero_data_retention: bool = False,
    poll_interval: int = 2,
    timeout: Optional[int] = None,
    request_timeout: Optional[float] = None,
) -> CrawlToStoreResult:
    """
    Crawl *url* and upsert the resulting pages into a Qdrant collection.

    When *skip_existing* is ``True`` (the default) each page is looked up in
    Qdrant by its deterministic point ID before embedding.  Pages whose content
    hash has not changed since the previous crawl are skipped entirely, making
    repeated crawls of the same site dramatically cheaper.

    Point IDs are derived from the page URL via UUID v5 so that every re-crawl
    upserts to the same slot rather than creating duplicates.  Deduplication
    checks use ``qdrant_client.retrieve()`` — a direct O(1) key lookup — so no
    payload index on the ``url`` field is required.

    Vectors are sent to Qdrant in batches (``batch_size`` points per request)
    to minimise round-trips for large crawls.  If a batch fails it is retried
    one point at a time so a single bad document does not drop the rest.

    Args:
        firecrawl_client: A :class:`~firecrawl.v2.client.FirecrawlClient` (or
            the unified :class:`~firecrawl.client.Firecrawl`) instance.
        url: Root URL to crawl.
        qdrant_client: An initialised ``qdrant_client.QdrantClient`` instance.
        collection_name: Name of the target Qdrant collection.  The collection
            must already exist with a vector size that matches the output of
            *embedding_fn*.
        embedding_fn: A callable ``(text: str) -> List[float]`` returning the
            embedding vector.  Called once per page that needs to be upserted.
        skip_existing: When ``True`` (default), pages already stored in Qdrant
            with an identical content hash are skipped.  Set to ``False`` to
            always re-embed and overwrite.
        content_key: Which :class:`~firecrawl.v2.types.Document` field to use
            as the text for hashing and embedding.  Defaults to ``"markdown"``.
            Accepted values: ``"markdown"``, ``"html"``, ``"raw_html"``.
        batch_size: Number of points sent to Qdrant in a single upsert call
            (default 100).
        prompt: Optional natural-language prompt to guide the crawl.
        exclude_paths: URL path patterns to exclude.
        include_paths: URL path patterns to include.
        max_discovery_depth: Maximum link-following depth.
        ignore_query_parameters: Treat URLs differing only in query params as
            identical.
        limit: Maximum number of pages to crawl.
        crawl_entire_domain: Follow links outside the start path.
        allow_external_links: Follow links to other domains.
        allow_subdomains: Follow links to subdomains.
        ignore_robots_txt: Skip robots.txt restrictions.
        delay: Seconds to wait between page requests.
        max_concurrency: Maximum simultaneous page requests.
        scrape_options: :class:`~firecrawl.v2.types.ScrapeOptions` applied to
            each page.
        deduplicate_similar_urls: Remove near-duplicate URLs (default ``True``).
        zero_data_retention: Delete raw data from Firecrawl servers after 24 h.
        poll_interval: Seconds between crawl-status polls.
        timeout: Maximum seconds to wait for the crawl to finish.
        request_timeout: Per-HTTP-request timeout in seconds.

    Returns:
        :class:`CrawlToStoreResult` with counts and the completed
        :class:`~firecrawl.v2.types.CrawlJob`.

    Raises:
        ImportError: If ``qdrant-client`` is not installed.
        ValueError: If *content_key* is not a valid Document field.
    """
    try:
        from qdrant_client.models import PointStruct
    except ImportError:
        raise ImportError(
            "qdrant-client is required for Qdrant integration. "
            "Install it with: pip install qdrant-client"
        )

    valid_content_keys = {"markdown", "html", "raw_html"}
    if content_key not in valid_content_keys:
        raise ValueError(
            f"content_key must be one of {valid_content_keys!r}, got {content_key!r}"
        )

    if batch_size < 1:
        raise ValueError(f"batch_size must be >= 1, got {batch_size!r}")

    # Run the crawl
    crawl_job = firecrawl_client.crawl(
        url,
        prompt=prompt,
        exclude_paths=exclude_paths,
        include_paths=include_paths,
        max_discovery_depth=max_discovery_depth,
        ignore_query_parameters=ignore_query_parameters,
        limit=limit,
        crawl_entire_domain=crawl_entire_domain,
        allow_external_links=allow_external_links,
        allow_subdomains=allow_subdomains,
        ignore_robots_txt=ignore_robots_txt,
        delay=delay,
        max_concurrency=max_concurrency,
        scrape_options=scrape_options,
        deduplicate_similar_urls=deduplicate_similar_urls,
        zero_data_retention=zero_data_retention,
        poll_interval=poll_interval,
        timeout=timeout,
        request_timeout=request_timeout,
    )

    documents = crawl_job.data or []
    total = len(documents)
    upserted = 0
    skipped = 0
    updated = 0
    errors: Dict[str, str] = {}

    # Pending batch accumulator: (PointStruct, url, is_update)
    batch: List[Any] = []
    batch_meta: List[Tuple[str, bool]] = []

    def _flush() -> None:
        nonlocal upserted, updated
        if not batch:
            return
        # Pass copies so that clearing the accumulators below does not
        # retroactively affect the snapshot sent to Qdrant (or to mocks).
        u, upd = _flush_batch(qdrant_client, collection_name, list(batch), list(batch_meta), errors)
        upserted += u
        updated += upd
        batch.clear()
        batch_meta.clear()

    for doc in documents:
        doc_url = _url_for_doc(doc)
        content = _get_content(doc, content_key)

        if not content:
            logger.debug("Skipping document with no %s content (url=%s)", content_key, doc_url)
            skipped += 1
            continue

        if not doc_url:
            logger.warning("Document has no URL in metadata; generating a random point ID.")

        current_hash = _content_hash(content)
        point_id = _url_to_point_id(doc_url) if doc_url else str(uuid.uuid4())

        # Deduplication check via direct O(1) retrieve by deterministic point ID
        is_update = False
        if skip_existing and doc_url:
            existing = _retrieve_existing_point(qdrant_client, collection_name, point_id)
            if existing is not None:
                existing_hash = (existing.payload or {}).get("content_hash")
                if existing_hash == current_hash:
                    skipped += 1
                    logger.debug("Skipping unchanged page: %s", doc_url)
                    continue
                # Content changed — overwrite the existing point in-place using
                # its own ID (always equal to point_id since IDs are deterministic,
                # but being explicit guards against any future ID scheme changes).
                point_id = existing.id
                is_update = True
                logger.debug("Updating changed page: %s", doc_url)

        # Embed
        try:
            vector = embedding_fn(content)
        except Exception as exc:
            msg = f"Embedding failed: {exc}"
            logger.warning("%s (url=%s)", msg, doc_url)
            if doc_url:
                errors[doc_url] = msg
            continue

        payload = _doc_to_payload(doc, content_key, current_hash)
        batch.append(PointStruct(id=point_id, vector=vector, payload=payload))
        batch_meta.append((doc_url or "", is_update))

        if len(batch) >= batch_size:
            _flush()

    # Flush remaining points
    _flush()

    return CrawlToStoreResult(
        total=total,
        upserted=upserted,
        skipped=skipped,
        updated=updated,
        crawl_job=crawl_job,
        errors=errors,
    )
