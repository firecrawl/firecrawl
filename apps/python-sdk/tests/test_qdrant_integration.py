"""
Unit tests for the Qdrant crawl_to_store integration.

All external calls (Firecrawl API + Qdrant client) are mocked so no live
services are required.
"""

import unittest
from unittest.mock import MagicMock, patch

from firecrawl.v2.integrations.qdrant import (
    crawl_to_store,
    CrawlToStoreResult,
    _content_hash,
    _url_to_point_id,
    _url_for_doc,
    _get_content,
    _retrieve_existing_point,
    _flush_batch,
)
from firecrawl.v2.types import Document, DocumentMetadata


# ---------------------------------------------------------------------------
# Shared test helpers
# ---------------------------------------------------------------------------

def _make_doc(url: str, markdown: str = "hello world", title: str = "Test") -> Document:
    """Build a minimal Document for testing."""
    meta = DocumentMetadata(url=url, title=title)
    return Document(markdown=markdown, metadata=meta)


def _make_crawl_job(docs):
    job = MagicMock()
    job.data = docs
    job.status = "completed"
    return job


def _make_qdrant_client(existing_point=None):
    """
    Return a mock QdrantClient.

    ``retrieve`` is the lookup path used by ``_retrieve_existing_point``.
    ``scroll`` is kept on the mock but should NOT be called by the new code.
    """
    qc = MagicMock()
    qc.retrieve.return_value = [existing_point] if existing_point else []
    qc.upsert.return_value = MagicMock()
    return qc


def _make_existing_point(url: str, content: str, custom_id: str = None) -> MagicMock:
    """Build a mock Qdrant point record with the given URL and content hash."""
    point = MagicMock()
    point.id = custom_id or _url_to_point_id(url)
    point.payload = {
        "url": url,
        "content_hash": _content_hash(content),
    }
    return point


# ---------------------------------------------------------------------------
# Helper function tests
# ---------------------------------------------------------------------------

class TestHelpers(unittest.TestCase):

    def test_content_hash_deterministic(self):
        self.assertEqual(_content_hash("hello"), _content_hash("hello"))

    def test_content_hash_differs_for_different_text(self):
        self.assertNotEqual(_content_hash("hello"), _content_hash("world"))

    def test_content_hash_is_64_hex_chars(self):
        h = _content_hash("test")
        self.assertEqual(len(h), 64)
        self.assertTrue(all(c in "0123456789abcdef" for c in h))

    def test_url_to_point_id_deterministic(self):
        self.assertEqual(
            _url_to_point_id("https://example.com/page"),
            _url_to_point_id("https://example.com/page"),
        )

    def test_url_to_point_id_differs_for_different_urls(self):
        self.assertNotEqual(
            _url_to_point_id("https://example.com/a"),
            _url_to_point_id("https://example.com/b"),
        )

    def test_url_to_point_id_is_valid_uuid_string(self):
        import uuid
        uuid.UUID(_url_to_point_id("https://example.com"))  # raises if invalid

    def test_url_for_doc_returns_metadata_url(self):
        self.assertEqual(_url_for_doc(_make_doc("https://example.com/page")), "https://example.com/page")

    def test_url_for_doc_falls_back_to_source_url(self):
        meta = DocumentMetadata(source_url="https://example.com/src")
        doc = Document(markdown="x", metadata=meta)
        self.assertEqual(_url_for_doc(doc), "https://example.com/src")

    def test_url_for_doc_returns_none_without_metadata(self):
        self.assertIsNone(_url_for_doc(Document(markdown="x")))

    def test_get_content_markdown(self):
        self.assertEqual(_get_content(_make_doc("https://x.com", markdown="# Hi"), "markdown"), "# Hi")

    def test_get_content_html(self):
        doc = Document(html="<h1>Hi</h1>", metadata=DocumentMetadata(url="https://x.com"))
        self.assertEqual(_get_content(doc, "html"), "<h1>Hi</h1>")

    def test_get_content_missing_field_returns_none(self):
        self.assertIsNone(_get_content(Document(metadata=DocumentMetadata(url="https://x.com")), "markdown"))


# ---------------------------------------------------------------------------
# _retrieve_existing_point — uses retrieve(), not scroll()
# ---------------------------------------------------------------------------

class TestRetrieveExistingPoint(unittest.TestCase):

    def test_returns_point_when_found(self):
        point = MagicMock()
        qc = MagicMock()
        qc.retrieve.return_value = [point]
        result = _retrieve_existing_point(qc, "my_col", "some-uuid")
        self.assertIs(result, point)

    def test_returns_none_when_not_found(self):
        qc = MagicMock()
        qc.retrieve.return_value = []
        result = _retrieve_existing_point(qc, "my_col", "some-uuid")
        self.assertIsNone(result)

    def test_calls_retrieve_not_scroll(self):
        qc = MagicMock()
        qc.retrieve.return_value = []
        _retrieve_existing_point(qc, "col", "id-123")
        qc.retrieve.assert_called_once()
        qc.scroll.assert_not_called()

    def test_passes_point_id_to_retrieve(self):
        qc = MagicMock()
        qc.retrieve.return_value = []
        _retrieve_existing_point(qc, "col", "target-id")
        call_kwargs = qc.retrieve.call_args[1]
        self.assertIn("target-id", call_kwargs["ids"])


# ---------------------------------------------------------------------------
# _flush_batch
# ---------------------------------------------------------------------------

class TestFlushBatch(unittest.TestCase):

    def _make_point(self):
        return MagicMock()

    def test_successful_batch_returns_correct_counts(self):
        qc = MagicMock()
        batch = [self._make_point(), self._make_point(), self._make_point()]
        meta = [("url1", False), ("url2", True), ("url3", False)]
        errors = {}
        u, upd = _flush_batch(qc, "col", batch, meta, errors)
        self.assertEqual(u, 3)
        self.assertEqual(upd, 1)
        self.assertEqual(errors, {})

    def test_batch_failure_retries_individually(self):
        qc = MagicMock()
        # First call (batch) fails; subsequent calls (individual) succeed
        qc.upsert.side_effect = [Exception("batch fail"), None, None]
        batch = [self._make_point(), self._make_point()]
        meta = [("url1", False), ("url2", True)]
        errors = {}
        u, upd = _flush_batch(qc, "col", batch, meta, errors)
        self.assertEqual(u, 2)
        self.assertEqual(upd, 1)
        self.assertEqual(errors, {})

    def test_individual_failure_recorded_in_errors(self):
        qc = MagicMock()
        qc.upsert.side_effect = [Exception("batch fail"), Exception("item fail"), None]
        batch = [self._make_point(), self._make_point()]
        meta = [("url_bad", False), ("url_ok", False)]
        errors = {}
        u, upd = _flush_batch(qc, "col", batch, meta, errors)
        self.assertEqual(u, 1)
        self.assertIn("url_bad", errors)
        self.assertNotIn("url_ok", errors)

    def test_empty_batch_returns_zeros(self):
        qc = MagicMock()
        errors = {}
        u, upd = _flush_batch(qc, "col", [], [], errors)
        self.assertEqual(u, 0)
        self.assertEqual(upd, 0)
        qc.upsert.assert_not_called()


# ---------------------------------------------------------------------------
# crawl_to_store — happy path: all pages are new
# ---------------------------------------------------------------------------

class TestCrawlToStoreNewPages(unittest.TestCase):

    def setUp(self):
        self.docs = [
            _make_doc("https://example.com/a", markdown="page a content"),
            _make_doc("https://example.com/b", markdown="page b content"),
        ]
        self.crawl_job = _make_crawl_job(self.docs)
        self.fc = MagicMock()
        self.fc.crawl.return_value = self.crawl_job
        self.qc = _make_qdrant_client(existing_point=None)
        self.embed = MagicMock(return_value=[0.1, 0.2, 0.3])

    def test_returns_crawl_to_store_result(self):
        result = crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col", embedding_fn=self.embed,
        )
        self.assertIsInstance(result, CrawlToStoreResult)

    def test_all_new_pages_upserted(self):
        result = crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col", embedding_fn=self.embed,
        )
        self.assertEqual(result.total, 2)
        self.assertEqual(result.upserted, 2)
        self.assertEqual(result.skipped, 0)
        self.assertEqual(result.updated, 0)

    def test_embedding_fn_called_once_per_page(self):
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col", embedding_fn=self.embed,
        )
        self.assertEqual(self.embed.call_count, 2)

    def test_qdrant_upsert_called_in_single_batch(self):
        """With 2 docs and default batch_size=100, only one upsert call is made."""
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col", embedding_fn=self.embed,
        )
        self.assertEqual(self.qc.upsert.call_count, 1)
        points_sent = self.qc.upsert.call_args[1]["points"]
        self.assertEqual(len(points_sent), 2)

    def test_point_payload_contains_url_and_hash(self):
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col", embedding_fn=self.embed,
        )
        points = self.qc.upsert.call_args[1]["points"]
        for point in points:
            self.assertIn("url", point.payload)
            self.assertIn("content_hash", point.payload)

    def test_uses_retrieve_not_scroll_for_dedup(self):
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col", embedding_fn=self.embed,
            skip_existing=True,
        )
        self.qc.retrieve.assert_called()
        self.qc.scroll.assert_not_called()

    def test_crawl_job_attached_to_result(self):
        result = crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col", embedding_fn=self.embed,
        )
        self.assertIs(result.crawl_job, self.crawl_job)


# ---------------------------------------------------------------------------
# Batching behaviour
# ---------------------------------------------------------------------------

class TestBatching(unittest.TestCase):

    def _run(self, n_docs, batch_size):
        docs = [_make_doc(f"https://example.com/{i}", markdown=f"content {i}") for i in range(n_docs)]
        fc = MagicMock()
        fc.crawl.return_value = _make_crawl_job(docs)
        qc = _make_qdrant_client()
        embed = MagicMock(return_value=[0.1])
        result = crawl_to_store(
            fc, "https://example.com",
            qdrant_client=qc, collection_name="col", embedding_fn=embed,
            batch_size=batch_size,
        )
        return result, qc

    def test_single_batch_when_docs_fit(self):
        _, qc = self._run(n_docs=5, batch_size=10)
        self.assertEqual(qc.upsert.call_count, 1)
        self.assertEqual(len(qc.upsert.call_args[1]["points"]), 5)

    def test_multiple_batches_when_docs_exceed_batch_size(self):
        _, qc = self._run(n_docs=7, batch_size=3)
        # ceil(7/3) = 3 upsert calls
        self.assertEqual(qc.upsert.call_count, 3)
        all_points = [p for call in qc.upsert.call_args_list for p in call[1]["points"]]
        self.assertEqual(len(all_points), 7)

    def test_exact_multiple_of_batch_size(self):
        _, qc = self._run(n_docs=6, batch_size=3)
        self.assertEqual(qc.upsert.call_count, 2)

    def test_invalid_batch_size_raises(self):
        docs = [_make_doc("https://x.com")]
        fc = MagicMock()
        fc.crawl.return_value = _make_crawl_job(docs)
        with self.assertRaises(ValueError):
            crawl_to_store(
                fc, "https://x.com",
                qdrant_client=MagicMock(), collection_name="col",
                embedding_fn=MagicMock(return_value=[0.1]),
                batch_size=0,
            )

    def test_all_upserted_correctly_counted_across_batches(self):
        result, _ = self._run(n_docs=10, batch_size=3)
        self.assertEqual(result.upserted, 10)


# ---------------------------------------------------------------------------
# skip_existing=True, identical content → skip
# ---------------------------------------------------------------------------

class TestCrawlToStoreSkipExisting(unittest.TestCase):

    def setUp(self):
        self.doc = _make_doc("https://example.com/a", markdown="unchanged content")
        self.fc = MagicMock()
        self.fc.crawl.return_value = _make_crawl_job([self.doc])
        self.embed = MagicMock(return_value=[0.1])
        existing = _make_existing_point("https://example.com/a", "unchanged content")
        self.qc = _make_qdrant_client(existing_point=existing)

    def test_unchanged_page_is_skipped(self):
        result = crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col",
            embedding_fn=self.embed, skip_existing=True,
        )
        self.assertEqual(result.skipped, 1)
        self.assertEqual(result.upserted, 0)

    def test_embedding_not_called_for_skipped_page(self):
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col",
            embedding_fn=self.embed, skip_existing=True,
        )
        self.embed.assert_not_called()

    def test_qdrant_not_upserted_for_skipped_page(self):
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col",
            embedding_fn=self.embed, skip_existing=True,
        )
        self.qc.upsert.assert_not_called()


# ---------------------------------------------------------------------------
# skip_existing=True, changed content → update using existing.id
# ---------------------------------------------------------------------------

class TestCrawlToStoreUpdateChanged(unittest.TestCase):

    def setUp(self):
        self.url = "https://example.com/a"
        self.doc = _make_doc(self.url, markdown="NEW content")
        self.fc = MagicMock()
        self.fc.crawl.return_value = _make_crawl_job([self.doc])
        self.embed = MagicMock(return_value=[0.5, 0.6])

        # Existing point has stale content AND a custom ID (simulates external insertion)
        self.custom_existing_id = "custom-id-from-another-process"
        existing = _make_existing_point(self.url, "OLD content", custom_id=self.custom_existing_id)
        self.qc = _make_qdrant_client(existing_point=existing)

    def test_changed_page_is_updated(self):
        result = crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col",
            embedding_fn=self.embed, skip_existing=True,
        )
        self.assertEqual(result.upserted, 1)
        self.assertEqual(result.updated, 1)
        self.assertEqual(result.skipped, 0)

    def test_uses_existing_point_id_for_update(self):
        """When updating, the existing point's own ID is used to overwrite in-place."""
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col",
            embedding_fn=self.embed, skip_existing=True,
        )
        points = self.qc.upsert.call_args[1]["points"]
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0].id, self.custom_existing_id)

    def test_embedding_called_for_updated_page(self):
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col",
            embedding_fn=self.embed, skip_existing=True,
        )
        self.embed.assert_called_once()


# ---------------------------------------------------------------------------
# skip_existing=False → always upsert, never call retrieve
# ---------------------------------------------------------------------------

class TestCrawlToStoreNoSkip(unittest.TestCase):

    def setUp(self):
        self.doc = _make_doc("https://example.com/a", markdown="same content")
        self.fc = MagicMock()
        self.fc.crawl.return_value = _make_crawl_job([self.doc])
        self.embed = MagicMock(return_value=[0.1])
        existing = _make_existing_point("https://example.com/a", "same content")
        self.qc = _make_qdrant_client(existing_point=existing)

    def test_page_upserted_even_if_unchanged(self):
        result = crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col",
            embedding_fn=self.embed, skip_existing=False,
        )
        self.assertEqual(result.upserted, 1)
        self.assertEqual(result.skipped, 0)

    def test_retrieve_not_called_when_skip_false(self):
        crawl_to_store(
            self.fc, "https://example.com",
            qdrant_client=self.qc, collection_name="col",
            embedding_fn=self.embed, skip_existing=False,
        )
        self.qc.retrieve.assert_not_called()
        self.qc.scroll.assert_not_called()


# ---------------------------------------------------------------------------
# Edge cases and failure paths
# ---------------------------------------------------------------------------

class TestCrawlToStoreEdgeCases(unittest.TestCase):

    def _base_fc(self, docs):
        fc = MagicMock()
        fc.crawl.return_value = _make_crawl_job(docs)
        return fc

    def test_empty_crawl_returns_zeros(self):
        result = crawl_to_store(
            self._base_fc([]), "https://example.com",
            qdrant_client=_make_qdrant_client(), collection_name="col",
            embedding_fn=MagicMock(),
        )
        self.assertEqual(result.total, 0)
        self.assertEqual(result.upserted, 0)
        self.assertEqual(result.skipped, 0)

    def test_doc_with_no_content_counted_in_skipped(self):
        """Missing content is counted in skipped (documented behaviour)."""
        doc = Document(metadata=DocumentMetadata(url="https://x.com"))
        result = crawl_to_store(
            self._base_fc([doc]), "https://example.com",
            qdrant_client=_make_qdrant_client(), collection_name="col",
            embedding_fn=MagicMock(),
        )
        self.assertEqual(result.skipped, 1)
        self.assertEqual(result.upserted, 0)

    def test_doc_with_no_content_does_not_call_embed(self):
        doc = Document(metadata=DocumentMetadata(url="https://x.com"))
        embed = MagicMock()
        crawl_to_store(
            self._base_fc([doc]), "https://example.com",
            qdrant_client=_make_qdrant_client(), collection_name="col",
            embedding_fn=embed,
        )
        embed.assert_not_called()

    def test_invalid_content_key_raises_value_error(self):
        with self.assertRaises(ValueError):
            crawl_to_store(
                self._base_fc([_make_doc("https://x.com")]), "https://example.com",
                qdrant_client=MagicMock(), collection_name="col",
                embedding_fn=MagicMock(), content_key="invalid_key",
            )

    def test_missing_qdrant_client_import_raises(self):
        doc = _make_doc("https://example.com/a")
        with patch.dict("sys.modules", {"qdrant_client": None, "qdrant_client.models": None}):
            with self.assertRaises((ImportError, TypeError)):
                crawl_to_store(
                    self._base_fc([doc]), "https://example.com",
                    qdrant_client=MagicMock(), collection_name="col",
                    embedding_fn=MagicMock(return_value=[0.1]),
                )

    def test_embedding_error_recorded_not_raised(self):
        doc = _make_doc("https://example.com/a", markdown="content")
        embed = MagicMock(side_effect=RuntimeError("embed failed"))
        result = crawl_to_store(
            self._base_fc([doc]), "https://example.com",
            qdrant_client=_make_qdrant_client(), collection_name="col",
            embedding_fn=embed,
        )
        self.assertEqual(result.upserted, 0)
        self.assertIn("https://example.com/a", result.errors)

    def test_qdrant_upsert_error_falls_back_to_individual_retry(self):
        """Batch failure triggers per-item retry; individual success still counted."""
        doc = _make_doc("https://example.com/a", markdown="content")
        qc = _make_qdrant_client()
        # First call is the batch attempt (fails), second is the individual retry (succeeds)
        qc.upsert.side_effect = [Exception("batch fail"), None]
        result = crawl_to_store(
            self._base_fc([doc]), "https://example.com",
            qdrant_client=qc, collection_name="col",
            embedding_fn=MagicMock(return_value=[0.1]),
        )
        self.assertEqual(result.upserted, 1)
        self.assertEqual(result.errors, {})

    def test_qdrant_individual_retry_failure_recorded(self):
        doc = _make_doc("https://example.com/a", markdown="content")
        qc = _make_qdrant_client()
        qc.upsert.side_effect = Exception("always fails")
        result = crawl_to_store(
            self._base_fc([doc]), "https://example.com",
            qdrant_client=qc, collection_name="col",
            embedding_fn=MagicMock(return_value=[0.1]),
        )
        self.assertEqual(result.upserted, 0)
        self.assertIn("https://example.com/a", result.errors)

    def test_deterministic_point_id_same_across_runs(self):
        url = "https://example.com/stable"
        docs_v1 = [_make_doc(url, markdown="v1")]
        docs_v2 = [_make_doc(url, markdown="v2")]

        fc1, fc2 = self._base_fc(docs_v1), self._base_fc(docs_v2)
        qc = _make_qdrant_client()
        embed = MagicMock(return_value=[0.1])

        crawl_to_store(fc1, "https://example.com", qdrant_client=qc, collection_name="c", embedding_fn=embed)
        crawl_to_store(fc2, "https://example.com", qdrant_client=qc, collection_name="c", embedding_fn=embed)

        ids = [qc.upsert.call_args_list[i][1]["points"][0].id for i in range(2)]
        self.assertEqual(ids[0], ids[1])

    def test_html_content_key(self):
        doc = Document(html="<p>hi</p>", metadata=DocumentMetadata(url="https://x.com"))
        qc = _make_qdrant_client()
        embed = MagicMock(return_value=[0.1])
        result = crawl_to_store(
            self._base_fc([doc]), "https://x.com",
            qdrant_client=qc, collection_name="col",
            embedding_fn=embed, content_key="html",
        )
        self.assertEqual(result.upserted, 1)
        embed.assert_called_once_with("<p>hi</p>")

    def test_crawl_kwargs_forwarded(self):
        doc = _make_doc("https://example.com/page")
        fc = self._base_fc([doc])
        crawl_to_store(
            fc, "https://example.com",
            qdrant_client=_make_qdrant_client(), collection_name="col",
            embedding_fn=MagicMock(return_value=[0.1]),
            limit=10, max_discovery_depth=3, allow_subdomains=True,
        )
        kw = fc.crawl.call_args[1]
        self.assertEqual(kw["limit"], 10)
        self.assertEqual(kw["max_discovery_depth"], 3)
        self.assertTrue(kw["allow_subdomains"])

    def test_mixed_new_skip_update_counts(self):
        """Three docs: one new, one unchanged (skip), one changed (update)."""
        new_doc = _make_doc("https://x.com/new", markdown="new content")
        same_doc = _make_doc("https://x.com/same", markdown="same content")
        changed_doc = _make_doc("https://x.com/changed", markdown="new version")

        def _retrieve_side(collection_name, ids, **kwargs):
            if ids[0] == _url_to_point_id("https://x.com/new"):
                return []
            if ids[0] == _url_to_point_id("https://x.com/same"):
                return [_make_existing_point("https://x.com/same", "same content")]
            if ids[0] == _url_to_point_id("https://x.com/changed"):
                return [_make_existing_point("https://x.com/changed", "old version")]
            return []

        fc = self._base_fc([new_doc, same_doc, changed_doc])
        qc = MagicMock()
        qc.retrieve.side_effect = _retrieve_side
        embed = MagicMock(return_value=[0.1])

        result = crawl_to_store(
            fc, "https://x.com",
            qdrant_client=qc, collection_name="col",
            embedding_fn=embed, skip_existing=True,
        )
        self.assertEqual(result.total, 3)
        self.assertEqual(result.skipped, 1)
        self.assertEqual(result.upserted, 2)  # new + changed
        self.assertEqual(result.updated, 1)   # only changed


# ---------------------------------------------------------------------------
# Client-level accessibility
# ---------------------------------------------------------------------------

class TestFirecrawlClientIntegration(unittest.TestCase):

    def test_crawl_to_store_on_firecrawl_client(self):
        from firecrawl.v2.client import FirecrawlClient
        self.assertTrue(callable(FirecrawlClient.crawl_to_store))

    def test_crawl_to_store_on_unified_client(self):
        from firecrawl import Firecrawl
        fc = Firecrawl(api_key="test", api_url="http://localhost:3002")
        self.assertTrue(callable(fc.crawl_to_store))

    def test_crawl_to_store_result_exported(self):
        from firecrawl import CrawlToStoreResult  # noqa: F401


if __name__ == "__main__":
    unittest.main()
