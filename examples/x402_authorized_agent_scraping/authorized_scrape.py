"""
Per-agent access control for Firecrawl scraping.

Shows how to gate Firecrawl API calls behind agent identity verification,
so only credentialed agents with the right permissions can scrape.

This is useful for multi-tenant setups where different agents (or agent
fleets) need different access levels — e.g., a research agent can read
but not spend, while a purchasing agent can make paid calls.

Setup:
    pip install -r requirements.txt
    npm install @bolyra/sdk        # ZK proofs run in Node.js
    cp .env.example .env           # add your FIRECRAWL_API_KEY
    python authorized_scrape.py
"""

import os
import sys

from dotenv import load_dotenv
from firecrawl import FirecrawlApp

from agent_auth import create_agent_identity, authorize


def main():
    load_dotenv()

    api_key = os.getenv("FIRECRAWL_API_KEY")
    if not api_key:
        print("Error: FIRECRAWL_API_KEY not set. Copy .env.example to .env and fill it in.")
        sys.exit(1)

    # --- 1. Set up agent identity (normally done once at deploy time) --------
    print("[1/3] Creating agent identity...")
    operator_secret = int(os.getenv("OPERATOR_SECRET", "42"))
    identity = create_agent_identity(operator_secret)
    print(f"      Agent credentialed (expires in 24 h)")

    # --- 2. Authorize the agent before it can call Firecrawl ----------------
    print("[2/3] Running authorization check (ZK proof)...")
    if not authorize(identity):
        print("DENIED — agent is not authorized. Aborting.")
        sys.exit(1)
    print("      Authorized.")

    # --- 3. Scrape with Firecrawl -------------------------------------------
    url = input("URL to scrape [https://firecrawl.dev]: ").strip() or "https://firecrawl.dev"

    print(f"[3/3] Scraping {url} ...")
    app = FirecrawlApp(api_key=api_key)
    result = app.scrape_url(url, params={"formats": ["markdown"]})

    markdown = result.get("markdown", "")
    print(f"      Done — {len(markdown)} chars returned.\n")

    # Show a preview
    preview = markdown[:500]
    print(preview)
    if len(markdown) > 500:
        print(f"\n... ({len(markdown) - 500} more chars)")


if __name__ == "__main__":
    main()
