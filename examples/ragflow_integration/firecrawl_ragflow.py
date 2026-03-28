"""
Firecrawl-RAGFlow Integration

This module provides a connector between Firecrawl's web scraping capabilities
and RAGFlow's RAG (Retrieval-Augmented Generation) pipeline. It enables users
to scrape web content using Firecrawl and import it directly into RAGFlow
datasets for use in knowledge bases and AI-powered question answering.

Features:
- Single URL scraping and import into RAGFlow
- Batch URL scraping with concurrent processing
- Full website crawling with depth control
- Automatic document chunking and parsing via RAGFlow
- Rate limit handling with exponential backoff
- Comprehensive error handling for common failure modes
"""

import hashlib
import io
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

from firecrawl import FirecrawlApp

logger = logging.getLogger(__name__)


@dataclass
class ScrapeResult:
    """Represents the result of scraping a single URL."""

    url: str
    title: str
    markdown: str
    html: Optional[str] = None
    metadata: dict = field(default_factory=dict)
    success: bool = True
    error: Optional[str] = None


@dataclass
class ImportResult:
    """Represents the result of importing content into RAGFlow."""

    url: str
    document_id: Optional[str] = None
    dataset_id: Optional[str] = None
    success: bool = True
    error: Optional[str] = None
    chunks_created: int = 0


class FirecrawlRAGFlowConnector:
    """
    Connector that bridges Firecrawl web scraping with RAGFlow document ingestion.

    This class provides methods to scrape web content using Firecrawl and import
    it into RAGFlow datasets, enabling users to build knowledge bases from web
    sources without manual copying or custom scraping implementations.

    Args:
        firecrawl_api_key: API key for Firecrawl authentication.
        ragflow_api_key: API key for RAGFlow authentication.
        ragflow_base_url: Base URL of the RAGFlow instance (e.g., "http://localhost:9380").
        firecrawl_api_url: Optional custom Firecrawl API URL for self-hosted instances.
        max_retries: Maximum number of retry attempts for failed requests.
        rate_limit_delay: Base delay in seconds between requests to avoid rate limiting.
        timeout: Request timeout in seconds.
    """

    def __init__(
        self,
        firecrawl_api_key: str,
        ragflow_api_key: str,
        ragflow_base_url: str,
        firecrawl_api_url: Optional[str] = None,
        max_retries: int = 3,
        rate_limit_delay: float = 1.0,
        timeout: int = 30,
    ):
        if not firecrawl_api_key:
            raise ValueError("firecrawl_api_key is required")
        if not ragflow_api_key:
            raise ValueError("ragflow_api_key is required")
        if not ragflow_base_url:
            raise ValueError("ragflow_base_url is required")

        self.firecrawl_api_key = firecrawl_api_key
        self.ragflow_api_key = ragflow_api_key
        self.ragflow_base_url = ragflow_base_url.rstrip("/")
        self.max_retries = max_retries
        self.rate_limit_delay = rate_limit_delay
        self.timeout = timeout

        # Initialize Firecrawl client
        firecrawl_kwargs = {"api_key": firecrawl_api_key}
        if firecrawl_api_url:
            firecrawl_kwargs["api_url"] = firecrawl_api_url
        self.firecrawl = FirecrawlApp(**firecrawl_kwargs)

        # Initialize RAGFlow client (lazy import to allow optional dependency)
        self._ragflow = None

    @property
    def ragflow(self):
        """Lazy initialization of RAGFlow client."""
        if self._ragflow is None:
            try:
                from ragflow_sdk import RAGFlow
            except ImportError:
                raise ImportError(
                    "ragflow-sdk is required for RAGFlow integration. "
                    "Install it with: pip install ragflow-sdk"
                )
            self._ragflow = RAGFlow(
                api_key=self.ragflow_api_key,
                base_url=self.ragflow_base_url,
            )
        return self._ragflow

    def _retry_with_backoff(self, func, *args, **kwargs):
        """Execute a function with exponential backoff retry logic."""
        last_error = None
        for attempt in range(self.max_retries):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                last_error = e
                error_str = str(e).lower()

                # Handle rate limiting (HTTP 429)
                if "429" in error_str or "rate limit" in error_str:
                    delay = self.rate_limit_delay * (2**attempt)
                    logger.warning(
                        "Rate limited (attempt %d/%d). Waiting %.1f seconds...",
                        attempt + 1,
                        self.max_retries,
                        delay,
                    )
                    time.sleep(delay)
                    continue

                # Handle authentication errors (no retry)
                if "401" in error_str or "unauthorized" in error_str:
                    logger.error("Authentication failed: %s", e)
                    raise

                # Handle forbidden errors (no retry)
                if "403" in error_str or "forbidden" in error_str:
                    logger.error("Access forbidden: %s", e)
                    raise

                # Handle not found errors (no retry)
                if "404" in error_str or "not found" in error_str:
                    logger.error("Resource not found: %s", e)
                    raise

                # Handle other transient errors with backoff
                delay = self.rate_limit_delay * (2**attempt)
                logger.warning(
                    "Request failed (attempt %d/%d): %s. Retrying in %.1f seconds...",
                    attempt + 1,
                    self.max_retries,
                    e,
                    delay,
                )
                time.sleep(delay)

        raise last_error

    def scrape_url(self, url: str, formats: Optional[list] = None) -> ScrapeResult:
        """
        Scrape a single URL using Firecrawl.

        Args:
            url: The URL to scrape.
            formats: Output formats to request (default: ["markdown"]).

        Returns:
            ScrapeResult with the scraped content.
        """
        if formats is None:
            formats = ["markdown"]

        try:
            result = self._retry_with_backoff(
                self.firecrawl.scrape_url,
                url,
                params={"formats": formats},
            )

            metadata = result.get("metadata", {})
            title = metadata.get("title", url)
            markdown = result.get("markdown", "")
            html = result.get("html")

            if not markdown and not html:
                return ScrapeResult(
                    url=url,
                    title=title,
                    markdown="",
                    metadata=metadata,
                    success=False,
                    error="No content extracted from URL",
                )

            return ScrapeResult(
                url=url,
                title=title,
                markdown=markdown,
                html=html,
                metadata=metadata,
                success=True,
            )

        except Exception as e:
            logger.error("Failed to scrape %s: %s", url, e)
            return ScrapeResult(
                url=url,
                title=url,
                markdown="",
                success=False,
                error=str(e),
            )

    def scrape_urls(self, urls: list[str], formats: Optional[list] = None) -> list[ScrapeResult]:
        """
        Scrape multiple URLs using Firecrawl batch scraping.

        Args:
            urls: List of URLs to scrape.
            formats: Output formats to request (default: ["markdown"]).

        Returns:
            List of ScrapeResult objects.
        """
        if formats is None:
            formats = ["markdown"]

        results = []
        try:
            batch_result = self._retry_with_backoff(
                self.firecrawl.batch_scrape_urls,
                urls,
                params={"formats": formats},
            )

            data_list = batch_result.get("data", [])
            for item in data_list:
                metadata = item.get("metadata", {})
                source_url = metadata.get("sourceURL", metadata.get("url", ""))
                title = metadata.get("title", source_url)
                markdown = item.get("markdown", "")

                results.append(
                    ScrapeResult(
                        url=source_url,
                        title=title,
                        markdown=markdown,
                        html=item.get("html"),
                        metadata=metadata,
                        success=bool(markdown),
                        error=None if markdown else "No content extracted",
                    )
                )

        except Exception as e:
            logger.error("Batch scrape failed: %s", e)
            # Fall back to individual scraping
            logger.info("Falling back to individual URL scraping...")
            for url in urls:
                result = self.scrape_url(url, formats=formats)
                results.append(result)
                time.sleep(self.rate_limit_delay)

        return results

    def crawl_website(
        self,
        url: str,
        max_depth: int = 2,
        limit: int = 50,
        formats: Optional[list] = None,
        include_paths: Optional[list[str]] = None,
        exclude_paths: Optional[list[str]] = None,
    ) -> list[ScrapeResult]:
        """
        Crawl an entire website using Firecrawl and return scraped content.

        Args:
            url: The root URL to start crawling from.
            max_depth: Maximum crawl depth (default: 2).
            limit: Maximum number of pages to crawl (default: 50).
            formats: Output formats to request (default: ["markdown"]).
            include_paths: URL path patterns to include (e.g., ["/docs/*"]).
            exclude_paths: URL path patterns to exclude (e.g., ["/blog/*"]).

        Returns:
            List of ScrapeResult objects for all crawled pages.
        """
        if formats is None:
            formats = ["markdown"]

        crawl_params = {
            "limit": limit,
            "maxDepth": max_depth,
            "scrapeOptions": {"formats": formats},
        }

        if include_paths:
            crawl_params["includePaths"] = include_paths
        if exclude_paths:
            crawl_params["excludePaths"] = exclude_paths

        results = []
        try:
            crawl_result = self._retry_with_backoff(
                self.firecrawl.crawl_url,
                url,
                params=crawl_params,
            )

            data_list = crawl_result.get("data", [])
            logger.info("Crawled %d pages from %s", len(data_list), url)

            for item in data_list:
                metadata = item.get("metadata", {})
                source_url = metadata.get("sourceURL", metadata.get("url", url))
                title = metadata.get("title", source_url)
                markdown = item.get("markdown", "")

                results.append(
                    ScrapeResult(
                        url=source_url,
                        title=title,
                        markdown=markdown,
                        html=item.get("html"),
                        metadata=metadata,
                        success=bool(markdown),
                        error=None if markdown else "No content extracted",
                    )
                )

        except Exception as e:
            logger.error("Crawl failed for %s: %s", url, e)
            # Return whatever we have plus the error
            results.append(
                ScrapeResult(
                    url=url,
                    title=url,
                    markdown="",
                    success=False,
                    error=f"Crawl failed: {e}",
                )
            )

        return results

    def _generate_document_id(self, url: str) -> str:
        """Generate a deterministic document ID from a URL."""
        url_hash = hashlib.md5(url.encode()).hexdigest()
        return f"firecrawl_{url_hash}"

    def _get_or_create_dataset(
        self,
        dataset_name: str,
        description: Optional[str] = None,
        chunk_method: str = "naive",
    ):
        """Get an existing dataset by name or create a new one."""
        try:
            dataset = self.ragflow.get_dataset(dataset_name)
            logger.info("Found existing dataset: %s", dataset_name)
            return dataset
        except Exception:
            logger.info("Creating new dataset: %s", dataset_name)
            return self.ragflow.create_dataset(
                name=dataset_name,
                description=description or f"Web content imported via Firecrawl",
                chunk_method=chunk_method,
            )

    def _sanitize_filename(self, title: str, url: str) -> str:
        """Create a safe filename from a page title and URL."""
        # Use title if available, otherwise derive from URL
        name = title if title and title != url else url.split("/")[-1] or "index"
        # Remove or replace unsafe characters
        safe_chars = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_. ")
        name = "".join(c if c in safe_chars else "_" for c in name)
        name = name.strip()[:200]  # Limit length
        if not name:
            name = self._generate_document_id(url)
        if not name.endswith(".md"):
            name += ".md"
        return name

    def import_to_ragflow(
        self,
        scrape_results: list[ScrapeResult],
        dataset_name: str,
        dataset_description: Optional[str] = None,
        chunk_method: str = "naive",
        auto_parse: bool = True,
    ) -> list[ImportResult]:
        """
        Import scraped content into a RAGFlow dataset.

        Args:
            scrape_results: List of ScrapeResult objects to import.
            dataset_name: Name of the RAGFlow dataset to create or use.
            dataset_description: Optional description for the dataset.
            chunk_method: Chunking method for RAGFlow (default: "naive").
            auto_parse: Whether to automatically trigger document parsing (default: True).

        Returns:
            List of ImportResult objects indicating success/failure for each document.
        """
        import_results = []

        # Filter out failed scrapes
        successful_scrapes = [r for r in scrape_results if r.success and r.markdown]
        if not successful_scrapes:
            logger.warning("No successful scrape results to import")
            return [
                ImportResult(
                    url=r.url,
                    success=False,
                    error=r.error or "Scrape failed - no content",
                )
                for r in scrape_results
            ]

        # Get or create the dataset
        try:
            dataset = self._get_or_create_dataset(
                dataset_name,
                description=dataset_description,
                chunk_method=chunk_method,
            )
        except Exception as e:
            logger.error("Failed to get/create dataset '%s': %s", dataset_name, e)
            return [
                ImportResult(url=r.url, success=False, error=f"Dataset error: {e}")
                for r in scrape_results
            ]

        # Upload each scraped document
        document_ids = []
        for scrape_result in successful_scrapes:
            try:
                filename = self._sanitize_filename(scrape_result.title, scrape_result.url)

                # Prepare markdown content with source metadata header
                content = f"# {scrape_result.title}\n\n"
                content += f"> Source: {scrape_result.url}\n\n"
                content += scrape_result.markdown

                # Upload as a markdown file
                document_list = [
                    {
                        "display_name": filename,
                        "blob": content.encode("utf-8"),
                    }
                ]

                docs = dataset.upload_documents(document_list)

                if docs:
                    doc = docs[0]
                    document_ids.append(doc.id)
                    import_results.append(
                        ImportResult(
                            url=scrape_result.url,
                            document_id=doc.id,
                            dataset_id=dataset.id,
                            success=True,
                        )
                    )
                    logger.info(
                        "Uploaded document: %s (ID: %s)", filename, doc.id
                    )
                else:
                    import_results.append(
                        ImportResult(
                            url=scrape_result.url,
                            dataset_id=dataset.id,
                            success=False,
                            error="Upload returned no documents",
                        )
                    )

            except Exception as e:
                logger.error(
                    "Failed to upload document for %s: %s", scrape_result.url, e
                )
                import_results.append(
                    ImportResult(
                        url=scrape_result.url,
                        dataset_id=dataset.id,
                        success=False,
                        error=str(e),
                    )
                )

        # Add results for failed scrapes
        for scrape_result in scrape_results:
            if not scrape_result.success or not scrape_result.markdown:
                import_results.append(
                    ImportResult(
                        url=scrape_result.url,
                        success=False,
                        error=scrape_result.error or "No content to import",
                    )
                )

        # Trigger parsing for uploaded documents
        if auto_parse and document_ids:
            try:
                logger.info("Triggering document parsing for %d documents...", len(document_ids))
                dataset.async_parse_documents(document_ids)
                logger.info("Document parsing initiated successfully")
            except Exception as e:
                logger.warning("Failed to trigger document parsing: %s", e)

        return import_results

    def scrape_and_import(
        self,
        url: str,
        dataset_name: str,
        dataset_description: Optional[str] = None,
        formats: Optional[list] = None,
        chunk_method: str = "naive",
        auto_parse: bool = True,
    ) -> ImportResult:
        """
        Scrape a single URL and import it into RAGFlow.

        This is a convenience method that combines scraping and importing
        in a single call.

        Args:
            url: The URL to scrape.
            dataset_name: Name of the RAGFlow dataset.
            dataset_description: Optional description for the dataset.
            formats: Output formats to request from Firecrawl.
            chunk_method: Chunking method for RAGFlow.
            auto_parse: Whether to automatically trigger document parsing.

        Returns:
            ImportResult for the scraped URL.
        """
        scrape_result = self.scrape_url(url, formats=formats)
        results = self.import_to_ragflow(
            [scrape_result],
            dataset_name=dataset_name,
            dataset_description=dataset_description,
            chunk_method=chunk_method,
            auto_parse=auto_parse,
        )
        return results[0] if results else ImportResult(
            url=url, success=False, error="No results returned"
        )

    def batch_scrape_and_import(
        self,
        urls: list[str],
        dataset_name: str,
        dataset_description: Optional[str] = None,
        formats: Optional[list] = None,
        chunk_method: str = "naive",
        auto_parse: bool = True,
    ) -> list[ImportResult]:
        """
        Scrape multiple URLs and import them into RAGFlow.

        Args:
            urls: List of URLs to scrape.
            dataset_name: Name of the RAGFlow dataset.
            dataset_description: Optional description for the dataset.
            formats: Output formats to request from Firecrawl.
            chunk_method: Chunking method for RAGFlow.
            auto_parse: Whether to automatically trigger document parsing.

        Returns:
            List of ImportResult objects.
        """
        scrape_results = self.scrape_urls(urls, formats=formats)
        return self.import_to_ragflow(
            scrape_results,
            dataset_name=dataset_name,
            dataset_description=dataset_description,
            chunk_method=chunk_method,
            auto_parse=auto_parse,
        )

    def crawl_and_import(
        self,
        url: str,
        dataset_name: str,
        dataset_description: Optional[str] = None,
        max_depth: int = 2,
        limit: int = 50,
        formats: Optional[list] = None,
        include_paths: Optional[list[str]] = None,
        exclude_paths: Optional[list[str]] = None,
        chunk_method: str = "naive",
        auto_parse: bool = True,
    ) -> list[ImportResult]:
        """
        Crawl an entire website and import all pages into RAGFlow.

        This method crawls a website starting from the given URL and imports
        all discovered pages into a RAGFlow dataset.

        Args:
            url: The root URL to start crawling from.
            dataset_name: Name of the RAGFlow dataset.
            dataset_description: Optional description for the dataset.
            max_depth: Maximum crawl depth.
            limit: Maximum number of pages to crawl.
            formats: Output formats to request from Firecrawl.
            include_paths: URL path patterns to include.
            exclude_paths: URL path patterns to exclude.
            chunk_method: Chunking method for RAGFlow.
            auto_parse: Whether to automatically trigger document parsing.

        Returns:
            List of ImportResult objects for all crawled pages.
        """
        scrape_results = self.crawl_website(
            url,
            max_depth=max_depth,
            limit=limit,
            formats=formats,
            include_paths=include_paths,
            exclude_paths=exclude_paths,
        )
        return self.import_to_ragflow(
            scrape_results,
            dataset_name=dataset_name,
            dataset_description=dataset_description,
            chunk_method=chunk_method,
            auto_parse=auto_parse,
        )
