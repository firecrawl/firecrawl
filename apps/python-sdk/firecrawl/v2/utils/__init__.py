"""
Utility modules for v2 API client.
"""

from .http_client import HttpClient
from .error_handler import FirecrawlError, handle_response_error
from .validation import validate_scrape_options, prepare_scrape_options

__all__ = ['HttpClient', 'FirecrawlError', 'handle_response_error', 'validate_scrape_options', 'prepare_scrape_options']