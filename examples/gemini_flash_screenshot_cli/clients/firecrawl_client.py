import os
import base64
import requests
from firecrawl import Firecrawl

class FirecrawlClient:
    def __init__(self, api_key: str, api_url: str = None):
    
        self.api_key = api_key
        self.client = Firecrawl(api_key=api_key)

    def capture(self, url: str, full_page: bool = True, mobile: bool = False, wait: int = 3) -> bytes:
        """
        Capture a screenshot from a URL and return bytes.
        """
        
        options = {"formats": [{"type": "screenshot", "fullPage": full_page}]}
        
        if mobile:
            options["mobile"] = True

        result = self.client.scrape(url, **options)

        screenshot = getattr(result, 'screenshot', None)
        if screenshot is None:
            screenshot = result.get('screenshot')

        if screenshot.startswith("http"):
            resp = requests.get(screenshot, timeout=30)
            resp.raise_for_status()
            return resp.content
        
        elif screenshot.startswith("data:"):
            return base64.b64decode(screenshot.split(",")[1])
        else:
            return base64.b64decode(screenshot)
