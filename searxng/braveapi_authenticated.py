# SPDX-License-Identifier: AGPL-3.0-or-later
"""Brave Search API engine with its key sourced from the environment."""

import os
import threading
import time

from searx.engines import braveapi as upstream
from searx.exceptions import SearxEngineAPIException

about = upstream.about
categories = upstream.categories
paging = upstream.paging
safesearch = upstream.safesearch
time_range_support = upstream.time_range_support
results_per_page = upstream.results_per_page

_rate_lock = threading.Lock()
_last_request_at = 0.0


def _pace_requests():
    """Keep bursty traffic within Brave's ceiling without an unbounded queue."""
    global _last_request_at

    try:
        minimum_interval = max(
            0.0,
            float(
                os.environ.get(
                    "SEARXNG_BRAVE_MIN_INTERVAL_SECONDS",
                    "2.1",
                )
            ),
        )
    except ValueError:
        minimum_interval = 2.1

    try:
        maximum_queue_seconds = max(
            0.0,
            float(
                os.environ.get(
                    "SEARXNG_BRAVE_MAX_QUEUE_SECONDS",
                    "4.5",
                )
            ),
        )
    except ValueError:
        maximum_queue_seconds = 4.5

    if not _rate_lock.acquire(timeout=maximum_queue_seconds):
        return False
    try:
        remaining = minimum_interval - (time.monotonic() - _last_request_at)
        if remaining > 0:
            time.sleep(remaining)
        _last_request_at = time.monotonic()
        return True
    finally:
        _rate_lock.release()


def init(_):
    token = os.environ.get("SEARXNG_BRAVE_API_KEY")
    if not token:
        raise SearxEngineAPIException("SEARXNG_BRAVE_API_KEY is not configured")
    upstream.api_key = token


def request(query, params):
    if not _pace_requests():
        # Empty URLs are intentionally ignored by SearXNG's online processor.
        # Other profile groups can complete instead of this request waiting
        # until Firecrawl's SearXNG client timeout and discarding their results.
        params["url"] = ""
        return
    upstream.api_key = os.environ.get("SEARXNG_BRAVE_API_KEY", "")
    return upstream.request(query, params)


response = upstream.response
