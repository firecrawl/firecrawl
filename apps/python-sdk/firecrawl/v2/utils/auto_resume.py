"""
Auto-resume policy for scrapes whose document keeps processing
server-side (large PDFs outlive their request window by design).

Shared by the sync and async scrape methods so the resume policy cannot
drift between transports. A resume only ever follows the server's
explicit ``details.state == "processing_continues"`` signal, and stops
after ``RESUME_MAX_ATTEMPTS`` resumes or ``RESUME_MAX_TOTAL_WAIT_S`` of
total sleeping - whichever comes first.
"""

import math
from typing import Optional

RESUME_MAX_ATTEMPTS = 5
RESUME_MAX_TOTAL_WAIT_S = 20 * 60
RESUME_MIN_DELAY_S = 5
RESUME_MAX_DELAY_S = 10 * 60


def processing_continues_delay_s(response) -> Optional[float]:
    """Delay (seconds) to wait before re-issuing a request whose document
    is still processing server-side, or None for every other response.

    The retry attaches to the in-flight job instead of restarting the
    work, so the eventual response is the finished document.
    """
    if response.status_code != 408:
        return None
    try:
        body = response.json()
    except Exception:
        return None
    details = body.get("details") if isinstance(body, dict) else None
    if (
        not isinstance(body, dict)
        or body.get("code") != "SCRAPE_TIMEOUT"
        or not isinstance(details, dict)
        or details.get("state") != "processing_continues"
    ):
        return None
    seconds = _finite_seconds(details.get("retryAfterSeconds"))
    if seconds is None:
        try:
            seconds = _finite_seconds(float(response.headers.get("Retry-After", "")))
        except (TypeError, ValueError):
            seconds = None
    if seconds is None:
        seconds = 60.0
    return min(RESUME_MAX_DELAY_S, max(RESUME_MIN_DELAY_S, seconds))


def _finite_seconds(value) -> Optional[float]:
    # bool is an int subclass in Python — a payload `true` must not read
    # as 1 second; NaN/Infinity must not survive into the clamp.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        value = float(value)
    except OverflowError:
        # Arbitrarily large JSON integers overflow float conversion.
        return None
    return value if math.isfinite(value) else None


class ResumeTracker:
    """The full resume decision, stateful, shared by both transports so
    bounds and accounting cannot drift between sync and async."""

    def __init__(self, enabled: bool):
        self._enabled = enabled
        self._resumes = 0
        self._waited_s = 0.0

    def delay_or_none(self, response) -> Optional[float]:
        """Delay to sleep before re-issuing, or None to surface the error.
        Recording is internal: a returned delay counts against the bounds."""
        if not self._enabled:
            return None
        delay_s = processing_continues_delay_s(response)
        if delay_s is None:
            return None
        if self._resumes >= RESUME_MAX_ATTEMPTS:
            return None
        if self._waited_s + delay_s > RESUME_MAX_TOTAL_WAIT_S:
            return None
        self._resumes += 1
        self._waited_s += delay_s
        return delay_s
