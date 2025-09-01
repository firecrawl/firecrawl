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
    
    def __init__(self, api_key: Optional[str], api_url: str):
        self.api_key = api_key
        self.api_url = api_url

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

    def _is_same_host(self, endpoint: str) -> bool:
        """
        Check if the endpoint targets the same host as the API base URL.
        
        Args:
            endpoint: The endpoint to check (can be relative or absolute)
            
        Returns:
            True if the endpoint targets the same host as the API base URL
            
        Note:
            This method compares hostnames only (ignoring ports and protocols).
            Edge cases:
            - IPv4 vs hostname: "127.0.0.1" vs "localhost" will not match
            - Ports are ignored: "api.firecrawl.dev:443" vs "api.firecrawl.dev:8080" will match
            - Bare hostnames without scheme are treated as relative endpoints
        """
        # For relative endpoints, they target the same host as the base URL
        if not endpoint.startswith(("http://", "https://")):
            return True
            
        # For absolute endpoints, compare hostnames
        try:
            parsed_target = urlparse(endpoint)
            target_host = (parsed_target.hostname or "").rstrip(".").lower()
            base_host = (urlparse(self.api_url).hostname or "").rstrip(".").lower()
            return target_host == base_host
        except Exception:
            # If parsing fails, assume it's not the same host for safety
            return False
    
    def _prepare_headers(self, endpoint: str, idempotency_key: Optional[str] = None) -> Dict[str, str]:
        """Prepare headers for API requests."""
        headers = {
            'Content-Type': 'application/json',
        }
        
        # Only add Authorization header if api_key is provided, not empty/whitespace, and same host
        if self.api_key and self.api_key.strip() and self._is_same_host(endpoint):
            headers['Authorization'] = f'Bearer {self.api_key.strip()}'
        
        if idempotency_key:
            headers['x-idempotency-key'] = idempotency_key
            
        return headers
    
    def post(
        self,
        endpoint: str,
        data: Dict[str, Any],
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: int = 3,
        backoff_factor: float = 0.5
    ) -> requests.Response:
        """Make a POST request with retry logic."""
        if headers is None:
            headers = self._prepare_headers(endpoint)

        data['origin'] = f'python-sdk@{version}'
            
        url = self._build_url(endpoint)
        
        last_exception = None
        
        for attempt in range(retries):
            try:
                response = requests.post(
                    url,
                    headers=headers,
                    json=data,
                    timeout=timeout
                )

                if response.status_code == 502:
                    if attempt < retries - 1:
                        time.sleep(backoff_factor * (2 ** attempt))
                        continue
                
                return response
                
            except requests.RequestException as e:
                last_exception = e
                if attempt == retries - 1:
                    raise e
                time.sleep(backoff_factor * (2 ** attempt))
        
        # This should never be reached due to the exception handling above
        raise last_exception or Exception("Unexpected error in POST request")
    
    def get(
        self,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: int = 3,
        backoff_factor: float = 0.5
    ) -> requests.Response:
        """Make a GET request with retry logic."""
        if headers is None:
            headers = self._prepare_headers(endpoint)

        url = self._build_url(endpoint)
        
        last_exception = None
        
        for attempt in range(retries):
            try:
                response = requests.get(
                    url,
                    headers=headers,
                    timeout=timeout
                )
                
                if response.status_code == 502:
                    if attempt < retries - 1:
                        time.sleep(backoff_factor * (2 ** attempt))
                        continue
                
                return response
                
            except requests.RequestException as e:
                last_exception = e
                if attempt == retries - 1:
                    raise e
                time.sleep(backoff_factor * (2 ** attempt))
        
        # This should never be reached due to the exception handling above
        raise last_exception or Exception("Unexpected error in GET request")
    
    def delete(
        self,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: int = 3,
        backoff_factor: float = 0.5
    ) -> requests.Response:
        """Make a DELETE request with retry logic."""
        if headers is None:
            headers = self._prepare_headers(endpoint)
            
        url = self._build_url(endpoint)
        
        last_exception = None
        
        for attempt in range(retries):
            try:
                response = requests.delete(
                    url,
                    headers=headers,
                    timeout=timeout
                )
                
                if response.status_code == 502:
                    if attempt < retries - 1:
                        time.sleep(backoff_factor * (2 ** attempt))
                        continue
                
                return response
                
            except requests.RequestException as e:
                last_exception = e
                if attempt == retries - 1:
                    raise e
                time.sleep(backoff_factor * (2 ** attempt))
        
        # This should never be reached due to the exception handling above
        raise last_exception or Exception("Unexpected error in DELETE request")