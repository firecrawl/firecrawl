#!/usr/bin/env python3
"""
Minimal websocket watcher examples (sync and async).

Env:
  FIRECRAWL_API_KEY
  FIRECRAWL_API_URL
"""

import os
import time
import asyncio
from dotenv import load_dotenv

from firecrawl import Firecrawl, Watcher, AsyncWatcher


def example_watcher() -> None:
    api_key = os.getenv("FIRECRAWL_API_KEY")
    api_url = os.getenv("FIRECRAWL_API_URL")
    if not api_key or not api_url:
        raise ValueError("FIRECRAWL_API_KEY and FIRECRAWL_API_URL must be set")

    client = Firecrawl(api_key=api_key, api_url=api_url)

    # Start a small crawl job
    job = client.start_crawl("https://docs.firecrawl.dev", limit=2)

    events = {"document": 0, "done": 0}
    statuses = []

    w: Watcher = client.watcher(job.id, kind="crawl", poll_interval=1, timeout=180)
    w.add_event_listener("document", lambda d: events.__setitem__("document", events["document"] + 1))
    w.add_event_listener("done", lambda d: events.__setitem__("done", events["done"] + 1))
    w.add_listener(lambda s: statuses.append(s.status))
    w.start()

    # Wait until terminal
    deadline = time.time() + 180
    while time.time() < deadline:
        if statuses and statuses[-1] in ("completed", "failed"):
            break
        time.sleep(1)
    w.stop()

    print("sync watcher:", {"last_status": statuses[-1] if statuses else None, **events})


async def example_async_watcher() -> None:
    """
    Example of using the async watcher.
    """
    api_key = os.getenv("FIRECRAWL_API_KEY")
    api_url = os.getenv("FIRECRAWL_API_URL")
    if not api_key or not api_url:
        raise ValueError("FIRECRAWL_API_KEY and FIRECRAWL_API_URL must be set")

    client = Firecrawl(api_key=api_key, api_url=api_url)

    # Start a small crawl job
    job = client.start_crawl("https://docs.firecrawl.dev", limit=2)

    async for snapshot in AsyncWatcher(client, job.id, kind="crawl"):
        print("async watcher:", snapshot.status, f"docs={len(snapshot.data)}")


def main() -> None:
    load_dotenv()
    example_watcher()
    asyncio.run(example_async_watcher())


if __name__ == "__main__":
    main()

