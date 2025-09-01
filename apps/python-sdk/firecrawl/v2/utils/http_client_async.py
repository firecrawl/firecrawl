import httpx
from typing import Optional, Dict, Any
from urllib.parse import urlparse
from .get_version import get_version

version = get_version()


class AsyncHttpClient:
    def __init__(self, api_key: Optional[str], api_url: str):
        self.api_key = api_key
        self.api_url = api_url
        
        self._client = httpx.AsyncClient(
            base_url=api_url,
            headers={"Content-Type": "application/json"},
            limits=httpx.Limits(max_keepalive_connections=0),
        )

    async def close(self) -> None:
        await self._client.aclose()

    def _is_same_host(self, endpoint: str) -> bool:
        """
        Check if the endpoint targets the same host as the API base URL.
        
        Args:
            endpoint: The endpoint to check (can be relative or absolute)
            
        Returns:
            True if the endpoint targets the same host as the API base URL
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

    def _headers(self, endpoint: str, idempotency_key: Optional[str] = None) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        
        # Only add Authorization header if api_key is provided, not empty/whitespace, and same host
        if self.api_key and self.api_key.strip() and self._is_same_host(endpoint):
            headers["Authorization"] = f"Bearer {self.api_key.strip()}"
            
        if idempotency_key:
            headers["x-idempotency-key"] = idempotency_key
        return headers

    async def post(
        self,
        endpoint: str,
        data: Dict[str, Any],
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> httpx.Response:
        payload = dict(data)
        payload["origin"] = f"python-sdk@{version}"
        return await self._client.post(
            endpoint,
            json=payload,
            headers={**self._headers(endpoint), **(headers or {})},
            timeout=timeout,
        )

    async def get(
        self,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> httpx.Response:
        return await self._client.get(
            endpoint, headers={**self._headers(endpoint), **(headers or {})}, timeout=timeout
        )

    async def delete(
        self,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> httpx.Response:
        return await self._client.delete(
            endpoint, headers={**self._headers(endpoint), **(headers or {})}, timeout=timeout
        )

