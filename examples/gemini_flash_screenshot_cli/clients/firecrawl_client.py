import os
import base64
import requests
from firecrawl import Firecrawl

class FirecrawlClient:
    def __init__(self, api_key: str, api_url: str = None):
        if not api_key:
            raise ValueError("Firecrawl API key is required.")
        self.api_key = api_key
        self.client = Firecrawl(api_key=api_key)

    def capture(self, url: str, full_page: bool = True, mobile: bool = False, wait: int = 3) -> bytes:
        """
        Capture a screenshot from a URL and return bytes.
        """
        options = {"formats": [{"type": "screenshot", "fullPage": full_page}]}
        if mobile:
            options["mobile"] = True

        try:
            result = self.client.scrape(url, **options)
        except Exception as e:
            raise RuntimeError(f"Firecrawl scrape failed: {e}")

        screenshot = getattr(result, "screenshot", None)
        if screenshot is None and isinstance(result, dict):
            screenshot = result.get("screenshot")

        if not screenshot:
            raise RuntimeError("No screenshot returned by Firecrawl.")

        try:
            if screenshot.startswith("http"):
                resp = requests.get(screenshot, timeout=30)
                resp.raise_for_status()
                return resp.content
            elif screenshot.startswith("data:"):
                return base64.b64decode(screenshot.split(",", 1)[1])
            else:
                return base64.b64decode(screenshot)
        except Exception as e:
            raise RuntimeError(f"Failed to decode screenshot: {e}")
