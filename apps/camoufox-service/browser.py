"""Camoufox browser lifecycle and cloak configuration.

Cloak choices here are deliberate, and each one is answering a documented
detection vector:

* **Own Xvfb at 1920x1080, not ``headless="virtual"``.** Camoufox's bundled
  virtual display hardcodes ``-screen 0 1x1x24`` (daijro/camoufox#458). A 1x1
  screen is a blatant automation tell and is a prime suspect in the
  "detected only inside Docker" reports (daijro/camoufox#311). We start our own
  Xvfb at a normal desktop resolution and hand Camoufox the display number, so
  the browser sees a plausible screen. Native headless mode is never used — the
  Camoufox docs warn it stays detectable.
* **Software GL present.** WebGL returning nothing is itself a signal; the
  image ships Mesa so WebGL answers with a real (spoofed) renderer.
* **``os="windows"`` by default.** Windows dominates real desktop traffic, and
  Camoufox keeps UA, platform, fonts and WebGL internally consistent with it.
* **``geoip=True``.** Locale/timezone/geolocation derived from the actual exit
  IP. An incoherent timezone-vs-IP pair is one of the cheapest checks a WAF can
  run.
* **``humanize=True`` plus a short warm-up.** Zero mouse/scroll activity is a
  documented reason for being forced into an interactive challenge.
* **Fresh context per request, shared browser.** Contexts are cheap and give
  per-job isolation (cookies, storage); relaunching the browser per job is not.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
from typing import Any, Dict, Optional

from camoufox.async_api import AsyncCamoufox

logger = logging.getLogger("camoufox.browser")


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().upper() in ("1", "TRUE", "YES", "ON")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


MAX_CONCURRENT_PAGES = max(1, _env_int("MAX_CONCURRENT_PAGES", 2))
NAVIGATION_TIMEOUT_MS = max(1000, _env_int("NAVIGATION_TIMEOUT_MS", 60000))
BLOCK_MEDIA = _env_bool("BLOCK_MEDIA", False)
HUMANIZE = _env_bool("CAMOUFOX_HUMANIZE", True)
USE_GEOIP = _env_bool("CAMOUFOX_GEOIP", True)
USE_FINGERPRINT_PRESET = _env_bool("CAMOUFOX_FINGERPRINT_PRESET", True)
TARGET_OS = os.environ.get("CAMOUFOX_OS", "windows").strip() or "windows"
VIRTUAL_DISPLAY = os.environ.get("DISPLAY", ":99")

# Pages made per browser process before it is recycled. Bounds memory growth and
# keeps a long-lived fingerprint from being reused indefinitely.
MAX_PAGES_PER_BROWSER = max(1, _env_int("CAMOUFOX_MAX_PAGES_PER_BROWSER", 200))


def build_launch_options() -> Dict[str, Any]:
    """Assemble Camoufox launch options, dropping any this version lacks."""
    options: Dict[str, Any] = {
        # Never native headless: we supply a real X display instead.
        "headless": False,
        "virtual_display": VIRTUAL_DISPLAY,
        "os": TARGET_OS,
        "humanize": HUMANIZE,
        "geoip": USE_GEOIP,
        "block_images": BLOCK_MEDIA,
        # Leave WebRTC and WebGL enabled: Camoufox spoofs both, and their
        # conspicuous absence is easier to detect than a spoofed value.
        "block_webrtc": False,
        "block_webgl": False,
        # No cross-job state.
        "enable_cache": False,
        "fingerprint_preset": USE_FINGERPRINT_PRESET,
    }

    # `fingerprint_preset` is recent; degrade gracefully on older packages
    # rather than failing to launch.
    try:
        from camoufox.utils import launch_options as _camoufox_launch_options

        supported = set(inspect.signature(_camoufox_launch_options).parameters)
        unsupported = [k for k in options if k not in supported]
        for key in unsupported:
            logger.warning(
                "Camoufox build does not support launch option %r; dropping it", key
            )
            options.pop(key)
    except (ImportError, TypeError, ValueError) as exc:  # noqa: BLE001
        logger.warning("Could not introspect Camoufox launch options: %s", exc)

    return options


class BrowserPool:
    """Owns a single Camoufox browser, restarting it if it dies."""

    def __init__(self, proxy_port: int) -> None:
        self._proxy_port = proxy_port
        self._manager: Optional[AsyncCamoufox] = None
        self._browser: Any = None
        self._lock = asyncio.Lock()
        self._pages_served = 0
        self.semaphore = asyncio.Semaphore(MAX_CONCURRENT_PAGES)
        self.launches = 0

    @property
    def proxy_server(self) -> str:
        return f"http://127.0.0.1:{self._proxy_port}"

    async def _launch_locked(self) -> None:
        options = build_launch_options()
        # Pinning the browser to the loopback guard proxy is what keeps it from
        # resolving DNS or opening sockets on its own.
        options["proxy"] = {"server": self.proxy_server}
        logger.info(
            "Launching Camoufox (os=%s humanize=%s geoip=%s preset=%s display=%s)",
            options.get("os"),
            options.get("humanize"),
            options.get("geoip"),
            options.get("fingerprint_preset"),
            options.get("virtual_display"),
        )
        manager = AsyncCamoufox(**options)
        self._browser = await manager.__aenter__()
        self._manager = manager
        self._pages_served = 0
        self.launches += 1

    async def _shutdown_locked(self) -> None:
        manager, self._manager, self._browser = self._manager, None, None
        if manager is None:
            return
        try:
            await manager.__aexit__(None, None, None)
        except Exception as exc:  # noqa: BLE001 - teardown must not mask the real error
            logger.warning("Error while shutting down Camoufox: %s", exc)

    async def get_browser(self) -> Any:
        async with self._lock:
            # The caller already owns one semaphore slot. Recycle only when it
            # is the sole active request; closing a browser with another live
            # context is what produced pending-task and unretrieved-future
            # warnings during fingerprint rotation.
            active_requests = MAX_CONCURRENT_PAGES - self.semaphore._value  # noqa: SLF001
            if (
                self._browser is not None
                and self._pages_served >= MAX_PAGES_PER_BROWSER
                and active_requests <= 1
            ):
                logger.info(
                    "Recycling Camoufox after %s pages", self._pages_served
                )
                await self._shutdown_locked()

            if self._browser is not None and not self._browser.is_connected():
                logger.warning("Camoufox browser disconnected; relaunching")
                await self._shutdown_locked()

            if self._browser is None:
                await self._launch_locked()

            self._pages_served += 1
            return self._browser

    async def ensure_healthy(self) -> bool:
        """Launch if necessary and report transport health without a page.

        Creating a randomized context in the health probe made liveness depend
        on optional WebGL fingerprint data and raced active scrape contexts.
        """
        async with self._lock:
            if self._browser is not None and not self._browser.is_connected():
                await self._shutdown_locked()
            if self._browser is None:
                await self._launch_locked()
            return bool(self._browser is not None and self._browser.is_connected())

    async def restart(self) -> None:
        """Force a clean relaunch after a crash."""
        async with self._lock:
            await self._shutdown_locked()

    async def close(self) -> None:
        async with self._lock:
            await self._shutdown_locked()

    def stats(self) -> Dict[str, Any]:
        return {
            "maxConcurrentPages": MAX_CONCURRENT_PAGES,
            "activePages": MAX_CONCURRENT_PAGES - self.semaphore._value,  # noqa: SLF001
            "browserLaunches": self.launches,
            "pagesServed": self._pages_served,
            "connected": bool(self._browser is not None and self._browser.is_connected()),
        }
