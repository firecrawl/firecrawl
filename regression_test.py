import httpx
import asyncio
import json
import re
import sys

URLS = [
    # HTML
    "https://example.com",
    "https://en.wikipedia.org/wiki/Web_scraping",
    "https://news.ycombinator.com/",
    # PDFs
    "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
    "https://unec.edu.az/application/uploads/2014/12/pdf-sample.pdf",
    "https://pdfobject.com/pdf/sample-3pp.pdf"
]

def analyze_markdown(md, url):
    if not md:
        print(f"  [!] No markdown returned for {url}")
        return False

    headings = len(re.findall(r'^#{1,6}\s', md, re.MULTILINE))
    links = len(re.findall(r'\[.*?\]\(.*?\)', md))
    tables = len(re.findall(r'\|.*\|.*\|', md))
    chars = len(md)

    print(f"  - Markdown length: {chars} chars")
    print(f"  - Headings: {headings}")
    print(f"  - Links: {links}")
    print(f"  - Tables lines: {tables}")
    
    if chars < 10:
        print(f"  [!] Markdown too short for {url}")
        return False
    return True

async def run():
    success = True
    async with httpx.AsyncClient(timeout=60.0) as client:
        print("Checking API Health...")
        try:
            resp = await client.get("http://localhost:3002/test")
            print("API:", resp.status_code, resp.text)
        except Exception as e:
            print("Health check failed:", e)
            sys.exit(1)

        for url in URLS:
            print(f"\nScraping {url} ...")
            payload = {
                "url": url,
                "formats": ["markdown", "html"]
            }
            headers = {
                "Content-Type": "application/json",
                "Authorization": "Bearer test"
            }
            try:
                resp = await client.post("http://localhost:3002/v1/scrape", json=payload, headers=headers)
                print(f"HTTP {resp.status_code}")
                if resp.status_code == 200:
                    data = resp.json()
                    md = data.get("data", {}).get("markdown", "")
                    if not analyze_markdown(md, url):
                        success = False
                else:
                    print("Error:", resp.text)
                    success = False
            except Exception as e:
                print(f"Failed to scrape {url}: {e}")
                success = False
                
    if success:
        print("\nAll regression tests PASSED.")
    else:
        print("\nSome regression tests FAILED.")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(run())
