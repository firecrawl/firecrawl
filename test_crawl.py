"""Real-topology trigger: KS/Firecrawl -> IC receiver.

Submits a small real crawl and points Firecrawl's signed webhook at the IC
receiver. Firecrawl runs in Docker; the IC receiver runs on the host, so the
webhook URL must use host.docker.internal (already mapped via extra_hosts in
docker-compose.yaml), NOT localhost/127.0.0.1.

Config via env (all optional, sane defaults for a local test):
  FIRECRAWL_URL   default http://localhost:3002
  FIRECRAWL_KEY   default "offline-local" (auth is bypassed in self-hosted mode)
  CRAWL_TARGET    default https://httpbin.org/html
  CRAWL_LIMIT     default 2
  IC_WEBHOOK_URL  default http://host.docker.internal:8009/webhook/firecrawl
"""
import asyncio
import os

import httpx

FIRECRAWL_URL = os.environ.get("FIRECRAWL_URL", "http://localhost:3002")
FIRECRAWL_KEY = os.environ.get("FIRECRAWL_KEY", "offline-local")
CRAWL_TARGET = os.environ.get("CRAWL_TARGET", "https://httpbin.org/html")
CRAWL_LIMIT = int(os.environ.get("CRAWL_LIMIT", "2"))
IC_WEBHOOK_URL = os.environ.get(
    "IC_WEBHOOK_URL", "http://host.docker.internal:8009/webhook/firecrawl"
)


async def run():
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.get(f"{FIRECRAWL_URL}/")
        print(f"[health] GET / -> {r.status_code}")

        payload = {
            "url": CRAWL_TARGET,
            "limit": CRAWL_LIMIT,
            "webhook": IC_WEBHOOK_URL,
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {FIRECRAWL_KEY}",
        }
        print(f"[crawl] target={CRAWL_TARGET} limit={CRAWL_LIMIT}")
        print(f"[crawl] webhook -> {IC_WEBHOOK_URL}")
        r = await client.post(
            f"{FIRECRAWL_URL}/v1/crawl", json=payload, headers=headers
        )
        print(f"[crawl] POST /v1/crawl -> {r.status_code}: {r.text[:200]}")
        if r.status_code != 200:
            return

        crawl_id = r.json()["id"]
        print(f"[crawl] id = {crawl_id}")

        for i in range(30):
            await asyncio.sleep(5)
            r = await client.get(
                f"{FIRECRAWL_URL}/v1/crawl/{crawl_id}", headers=headers
            )
            body = r.json()
            print(
                f"[poll {i}] status={body.get('status')} "
                f"completed={body.get('completed')}/{body.get('total')}"
            )
            if body.get("status") in ("completed", "failed"):
                print(f"[done] final crawl status = {body.get('status')}")
                return


if __name__ == "__main__":
    asyncio.run(run())
