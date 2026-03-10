import asyncio
import httpx
from typing import Optional, Dict, Any
from .get_version import get_version

version = get_version()


class AsyncHttpClient:
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

        headers = {
            "Content-Type": "application/json",
        }

        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        self._client = httpx.AsyncClient(
            base_url=api_url,
            headers=headers,
            limits=httpx.Limits(max_keepalive_connections=0),
        )

    async def close(self) -> None:
        await self._client.aclose()

    def _headers(self, idempotency_key: Optional[str] = None) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        if idempotency_key:
            headers["x-idempotency-key"] = idempotency_key
        return headers

    async def post(
        self,
        endpoint: str,
        data: Dict[str, Any],
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
        backoff_factor: Optional[float] = None,
    ) -> httpx.Response:
        if timeout is None:
            timeout = self.timeout
        if retries is None:
            retries = self.max_retries
        if backoff_factor is None:
            backoff_factor = self.backoff_factor

        payload = dict(data)
        payload["origin"] = f"python-sdk@{version}"

        last_exception = None
        num_attempts = max(1, retries)

        for attempt in range(num_attempts):
            try:
                response = await self._client.post(
                    endpoint,
                    json=payload,
                    headers={**self._headers(), **(headers or {})},
                    timeout=timeout,
                )
                if response.status_code == 502:
                    if attempt < num_attempts - 1:
                        await asyncio.sleep(backoff_factor * (2 ** attempt))
                        continue
                return response
            except httpx.HTTPError as e:
                last_exception = e
                if attempt == num_attempts - 1:
                    raise e
                await asyncio.sleep(backoff_factor * (2 ** attempt))

        raise last_exception or Exception("Unexpected error in POST request")

    async def get(
        self,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
        backoff_factor: Optional[float] = None,
    ) -> httpx.Response:
        if timeout is None:
            timeout = self.timeout
        if retries is None:
            retries = self.max_retries
        if backoff_factor is None:
            backoff_factor = self.backoff_factor

        last_exception = None
        num_attempts = max(1, retries)

        for attempt in range(num_attempts):
            try:
                response = await self._client.get(
                    endpoint,
                    headers={**self._headers(), **(headers or {})},
                    timeout=timeout,
                )
                if response.status_code == 502:
                    if attempt < num_attempts - 1:
                        await asyncio.sleep(backoff_factor * (2 ** attempt))
                        continue
                return response
            except httpx.HTTPError as e:
                last_exception = e
                if attempt == num_attempts - 1:
                    raise e
                await asyncio.sleep(backoff_factor * (2 ** attempt))

        raise last_exception or Exception("Unexpected error in GET request")

    async def delete(
        self,
        endpoint: str,
        headers: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
        retries: Optional[int] = None,
        backoff_factor: Optional[float] = None,
    ) -> httpx.Response:
        if timeout is None:
            timeout = self.timeout
        if retries is None:
            retries = self.max_retries
        if backoff_factor is None:
            backoff_factor = self.backoff_factor

        last_exception = None
        num_attempts = max(1, retries)

        for attempt in range(num_attempts):
            try:
                response = await self._client.delete(
                    endpoint,
                    headers={**self._headers(), **(headers or {})},
                    timeout=timeout,
                )
                if response.status_code == 502:
                    if attempt < num_attempts - 1:
                        await asyncio.sleep(backoff_factor * (2 ** attempt))
                        continue
                return response
            except httpx.HTTPError as e:
                last_exception = e
                if attempt == num_attempts - 1:
                    raise e
                await asyncio.sleep(backoff_factor * (2 ** attempt))

        raise last_exception or Exception("Unexpected error in DELETE request")
