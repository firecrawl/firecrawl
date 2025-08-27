"""
HTTP client utilities for v2 API.
"""

import time
from typing import Dict, Any, Optional
import requests
from .get_version import get_version

version = get_version()

class HttpClient:
    """HTTP client with retry logic and error handling."""
    
    def __init__(self, api_key: str, api_url: str):
        self.api_key = api_key
        self.api_url = api_url
    
    def _prepare_headers(self, idempotency_key: Optional[str] = None) -> Dict[str, str]:
        """Prepare headers for API requests."""
        headers = {
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {self.api_key}',
        }
        
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
            headers = self._prepare_headers()

        data['origin'] = f'python-sdk@{version}'
            
        url = f"{self.api_url}{endpoint}"
        
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
            headers = self._prepare_headers()

        url = f"{self.api_url}{endpoint}"
        
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
            headers = self._prepare_headers()
            
        url = f"{self.api_url}{endpoint}"
        
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