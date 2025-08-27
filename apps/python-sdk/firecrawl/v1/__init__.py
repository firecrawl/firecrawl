"""
Firecrawl v1 API (Legacy)

This module provides the legacy v1 API for backward compatibility.

Usage:
    from firecrawl.v1 import V1FirecrawlApp
    app = V1FirecrawlApp(api_key="your-api-key")
    result = app.scrape_url("https://example.com")
"""

from .client import V1FirecrawlApp, AsyncV1FirecrawlApp, V1JsonConfig, V1ScrapeOptions, V1ChangeTrackingOptions

__all__ = ['V1FirecrawlApp', 'AsyncV1FirecrawlApp', 'V1JsonConfig', 'V1ScrapeOptions', 'V1ChangeTrackingOptions']