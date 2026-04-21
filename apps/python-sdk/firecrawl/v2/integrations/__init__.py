"""
Optional integrations for Firecrawl v2.
"""

from .qdrant import crawl_to_store, CrawlToStoreResult

__all__ = ["crawl_to_store", "CrawlToStoreResult"]
