"""
Configuration for the Firecrawl RAGFlow data source connector.
"""

import os
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class FirecrawlSourceConfig:
    """Configuration for the Firecrawl data source in RAGFlow."""

    api_key: str = ""
    api_url: str = "https://api.firecrawl.dev"

    # URLs to scrape or crawl
    urls: List[str] = field(default_factory=list)

    # "scrape" for individual URLs, "crawl" for full-site crawl
    mode: str = "scrape"

    # Crawl-specific settings
    crawl_limit: int = 100

    # Output format requested from Firecrawl
    formats: List[str] = field(default_factory=lambda: ["markdown"])

    # Request behaviour
    timeout: int = 60
    max_retries: int = 3
    rate_limit_delay: float = 1.0

    # Optional: tags to exclude when scraping
    exclude_tags: Optional[List[str]] = None

    def __post_init__(self):
        if not self.api_key:
            self.api_key = os.getenv("FIRECRAWL_API_KEY", "")
        if not self.api_url:
            self.api_url = os.getenv("FIRECRAWL_API_URL", "https://api.firecrawl.dev")

    def validate(self) -> List[str]:
        """Return a list of validation error strings (empty == valid)."""
        errors: List[str] = []
        if not self.api_key:
            errors.append("Firecrawl API key is required")
        if not self.api_key.startswith("fc-") and self.api_key:
            errors.append("Firecrawl API key must start with 'fc-'")
        if not self.urls and self.mode == "scrape":
            errors.append("At least one URL is required for scrape mode")
        if not self.urls and self.mode == "crawl":
            errors.append("A starting URL is required for crawl mode")
        if self.mode not in ("scrape", "crawl"):
            errors.append("Mode must be 'scrape' or 'crawl'")
        if not self.api_url or not self.api_url.strip():
            errors.append("Firecrawl API URL is required")
        elif not self.api_url.startswith(("http://", "https://")):
            errors.append("Firecrawl API URL must include a scheme (http:// or https://)")
        return errors
