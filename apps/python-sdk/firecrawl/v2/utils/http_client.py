"""
HTTP client utilities for v2 API.
"""

import time
from typing import Dict, Any, Optional
from urllib.parse import urlparse, urlunparse, urljoin
import requests
from .get_version import get_version

version = get_version()

class HttpClient:
    """HTTP client with retry logic and error handling."""

    def __init__(
        self,
        api_key: Optional[str],
        api_url: str,
        timeout: Optional[float] = None,
        max_retries: int = 3,
        backoff_factor: float = 0.5,
    ):
        self.api_key = api_key
        self.api_url = api_url
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff_factor = backoff_factor

    def _build_url(self, endpoint: str) -> str:
        base = urlparse(self.api_url)
        ep = urlparse(endpoint)

        # Absolute or protocol-relative (has netloc)
        if ep.netloc:
            # Different host: keep path/query but force base host/scheme (no token leakage)
            path = ep.path or "/"
            if (ep.hostname or "") != (base.hostname or ""):
                return urlunparse((base.scheme or "https", base.netloc, path, "", ep.query, ""))
            # Same host: normalize scheme to base
            return urlunparse((base.scheme or "https", base.netloc, path, "", ep.query, ""))

        # Relative (including leading slash or not)
        base_str = self.api_url if self.api_url.endswith("/") else f"{self.api_url}/"
        # Guard protocol-relative like //host/path slipping through as “relative”
        if endpoint.startswith("//"):
            ep2 = urlparse(f"https:{endpoint}")
            path = ep2.path or "/"
            return urlunparse((base.scheme or "https", base.netloc, path, "", ep2.query, ""))
        return urljoin(base_str, endpoint)
    
    def _prepare_headers(self, idempotency_key: Optional[str] = None) -> Dict[str, str]:
        """Prepare headers for API requests."""
        headers = {
            'Content-Type': 'application/json',
        }

        if self.api_key:
            headers['Authorization'] = f'Bearer {self.api_key}'
        
        if idempotency_key:
            headers['x-idempotency-key'] = idempotency_key
            
        return headers
    
    def post(
        self,
        endpoint: str,
        data: Dict[str, Any],
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
        backoff_factor: Optional[float] = None,
    ) -> requests.Response:
        """Make a POST request with retry logic."""
        if headers is None:
            headers = self._prepare_headers()
        if timeout is None:
            timeout = self.timeout
        if retries is None:
            retries = self.max_retries
        if backoff_factor is None:
            backoff_factor = self.backoff_factor

        data['origin'] = f'python-sdk@{version}'

        url = self._build_url(endpoint)

        last_exception = None
        num_attempts = max(1, retries)

        for attempt in range(num_attempts):
            try:
                response = requests.post(
                    url,
                    headers=headers,
                    json=data,
                    timeout=timeout
                )

                if response.status_code == 502:
                    if attempt < num_attempts - 1:
                        time.sleep(backoff_factor * (2 ** attempt))
                        continue

                return response

            except requests.RequestException as e:
                last_exception = e
                if attempt == num_attempts - 1:
                    raise e
                time.sleep(backoff_factor * (2 ** attempt))

        # This should never be reached due to the exception handling above
        raise last_exception or Exception("Unexpected error in POST request")
    
    def get(
        self,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
        backoff_factor: Optional[float] = None,
    ) -> requests.Response:
        """Make a GET request with retry logic."""
        if headers is None:
            headers = self._prepare_headers()
        if timeout is None:
            timeout = self.timeout
        if retries is None:
            retries = self.max_retries
        if backoff_factor is None:
            backoff_factor = self.backoff_factor

        url = self._build_url(endpoint)

        last_exception = None
        num_attempts = max(1, retries)

        for attempt in range(num_attempts):
            try:
                response = requests.get(
                    url,
                    headers=headers,
                    timeout=timeout
                )

                if response.status_code == 502:
                    if attempt < num_attempts - 1:
                        time.sleep(backoff_factor * (2 ** attempt))
                        continue

                return response

            except requests.RequestException as e:
                last_exception = e
                if attempt == num_attempts - 1:
                    raise e
                time.sleep(backoff_factor * (2 ** attempt))

        # This should never be reached due to the exception handling above
        raise last_exception or Exception("Unexpected error in GET request")
    
    def delete(
        self,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
        backoff_factor: Optional[float] = None,
    ) -> requests.Response:
        """Make a DELETE request with retry logic."""
        if headers is None:
            headers = self._prepare_headers()
        if timeout is None:
            timeout = self.timeout
        if retries is None:
            retries = self.max_retries
        if backoff_factor is None:
            backoff_factor = self.backoff_factor

        url = self._build_url(endpoint)

        last_exception = None
        num_attempts = max(1, retries)

        for attempt in range(num_attempts):
            try:
                response = requests.delete(
                    url,
                    headers=headers,
                    timeout=timeout
                )

                if response.status_code == 502:
                    if attempt < num_attempts - 1:
                        time.sleep(backoff_factor * (2 ** attempt))
                        continue

                return response

            except requests.RequestException as e:
                last_exception = e
                if attempt == num_attempts - 1:
                    raise e
                time.sleep(backoff_factor * (2 ** attempt))

        # This should never be reached due to the exception handling above
        raise last_exception or Exception("Unexpected error in DELETE request")