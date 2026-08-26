"""
Auto-resume policy for scrapes whose document keeps processing
server-side (large PDFs outlive their request window by design).

Shared by the sync and async scrape methods so the resume policy cannot
drift between transports. A resume only ever follows the server's
explicit ``details.state == "processing_continues"`` signal, and stops
after ``RESUME_MAX_ATTEMPTS`` resumes or ``RESUME_MAX_TOTAL_WAIT_S`` of
total sleeping - whichever comes first.
"""

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
    seconds = details.get("retryAfterSeconds")
    if not isinstance(seconds, (int, float)):
        try:
            seconds = float(response.headers.get("Retry-After", ""))
        except (TypeError, ValueError):
            seconds = 60
    return min(RESUME_MAX_DELAY_S, max(RESUME_MIN_DELAY_S, float(seconds)))
