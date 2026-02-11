"""
Firecrawl integration for RAGFlow.

Provides a data source connector that allows RAGFlow users to import
web content via Firecrawl's scraping and crawling APIs.
"""

from .connector import FirecrawlConnector
from .config import FirecrawlSourceConfig

__all__ = ["FirecrawlConnector", "FirecrawlSourceConfig"]
