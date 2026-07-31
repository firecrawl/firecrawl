"""SSRF controls for the Camoufox service.

Two layers, both mandatory:

1. ``assert_safe_target_url`` — checked before navigation and again for every
   request the page makes (including redirects and subresources).
2. ``SsrfGuardProxy`` — a loopback-only forward proxy the browser is pinned to.
   Because the browser never resolves DNS or opens sockets itself, this is the
   layer that actually enforces the policy: the proxy resolves the name, rejects
   the connection unless *every* returned address is globally routable, and then
   dials the exact address it validated. Pinning the dialled address is what
   closes the DNS-rebinding window — there is no second lookup to poison.

Unlike the Playwright service there is no ``ALLOW_LOCAL_WEBHOOKS`` escape hatch
here. Camoufox exists to retry public sites that answered with an anti-bot
challenge; it has no legitimate reason to reach a private address, so the
override is deliberately not extended to this service.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
from typing import List, Optional, Tuple
from urllib.parse import urlsplit

logger = logging.getLogger("camoufox.ssrf")

ALLOWED_SCHEMES = ("http", "https")

# Only these ports may be tunnelled. Keeps the proxy from being used to reach
# arbitrary TCP services even on a globally routable address.
ALLOWED_PORTS = (80, 443, 8080, 8443)


class InsecureConnectionError(Exception):
    """Raised when a target fails the SSRF policy."""

    def __init__(self, blocked_url: str, reason: str) -> None:
        super().__init__(f'Blocked insecure target URL "{blocked_url}": {reason}')
        self.blocked_url = blocked_url
        self.reason = reason


def is_global_address(raw: str) -> bool:
    """True only for addresses that are safe to dial from inside the network.

    Rejects loopback, link-local (including 169.254.169.254 cloud metadata),
    multicast, private/RFC1918, unique-local, reserved, unspecified and
    carrier-grade NAT space, in both IPv4 and IPv6. IPv6 forms that embed an
    IPv4 address (v4-mapped, 6to4, Teredo) are unwrapped and re-checked so they
    cannot be used to smuggle a private destination.
    """
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError:
        return False

    if addr.version == 6:
        mapped = addr.ipv4_mapped
        if mapped is not None:
            return is_global_address(str(mapped))
        sixtofour = getattr(addr, "sixtofour", None)
        if sixtofour is not None:
            return is_global_address(str(sixtofour))
        teredo = getattr(addr, "teredo", None)
        if teredo is not None:
            return all(is_global_address(str(part)) for part in teredo)

    if (
        addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_private
        or addr.is_reserved
        or addr.is_unspecified
    ):
        return False

    # `is_global` also excludes shared address space (100.64.0.0/10) and the
    # various IANA special-purpose ranges.
    return bool(addr.is_global)


async def resolve_global_addresses(hostname: str, port: int) -> List[Tuple[int, str]]:
    """Resolve ``hostname`` and return ``(family, address)`` pairs.

    Raises if the name does not resolve, or if *any* returned address is not
    globally routable. Failing on any bad record — rather than filtering them
    out — stops a hostile resolver from mixing one public answer in with a
    private one to get past the check.
    """
    host = hostname.strip().strip("[]").lower().rstrip(".")
    if not host:
        raise InsecureConnectionError(hostname, "empty hostname")

    # Literal IPs skip DNS entirely.
    try:
        ipaddress.ip_address(host)
        if not is_global_address(host):
            raise InsecureConnectionError(
                hostname, "resolves to a private/internal address"
            )
        family = (
            socket.AF_INET6 if ipaddress.ip_address(host).version == 6 else socket.AF_INET
        )
        return [(family, host)]
    except ValueError:
        pass

    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise InsecureConnectionError(hostname, f"DNS resolution failed: {exc}") from exc

    if not infos:
        raise InsecureConnectionError(hostname, "DNS resolution returned no addresses")

    resolved: List[Tuple[int, str]] = []
    for family, _type, _proto, _canon, sockaddr in infos:
        address = sockaddr[0]
        if not is_global_address(address):
            raise InsecureConnectionError(
                hostname, "resolves to a private/internal address"
            )
        resolved.append((family, address))

    return resolved


#: Short-lived cache of (host, port) -> verdict for the *route interceptor*.
#:
#: A commercial page pulls hundreds of subresources, and resolving every one of
#: them inline made navigation miss its deadline (a real 504 observed on
#: lovehoney.com). Caching is safe here because the route guard is
#: defence-in-depth, not the enforcing layer: SsrfGuardProxy re-resolves on
#: every actual connection and pins the address it validated, so a stale
#: positive here cannot turn into a connection to a private address.
_VERDICT_TTL_SECONDS = 60.0
_verdict_cache: dict[tuple[str, int], tuple[float, Optional[str]]] = {}


def _cache_get(key: Tuple[str, int], now: float) -> Optional[Tuple[bool, Optional[str]]]:
    entry = _verdict_cache.get(key)
    if entry is None:
        return None
    expires_at, reason = entry
    if expires_at < now:
        _verdict_cache.pop(key, None)
        return None
    return (reason is None, reason)


def _cache_put(key: Tuple[str, int], reason: Optional[str], now: float) -> None:
    if len(_verdict_cache) > 4096:
        _verdict_cache.clear()
    _verdict_cache[key] = (now + _VERDICT_TTL_SECONDS, reason)


async def assert_safe_target_url(url: str, *, use_cache: bool = False) -> None:
    """Validate scheme, port and resolved addresses for ``url``.

    ``use_cache`` is for the high-volume route interceptor only. The proxy and
    the pre-navigation check always resolve for real.
    """
    # urlsplit itself raises on some malformed inputs (e.g. an unterminated
    # IPv6 literal), so parsing has to be guarded too.
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise InsecureConnectionError(url, f"URL is invalid: {exc}") from exc

    if parts.scheme not in ALLOWED_SCHEMES:
        raise InsecureConnectionError(url, f'unsupported protocol "{parts.scheme}:"')

    try:
        hostname = parts.hostname
    except ValueError as exc:
        raise InsecureConnectionError(url, f"URL is invalid: {exc}") from exc

    if not hostname:
        raise InsecureConnectionError(url, "URL is invalid")

    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise InsecureConnectionError(url, f"invalid port: {exc}") from exc

    if port not in ALLOWED_PORTS:
        raise InsecureConnectionError(url, f"port {port} is not allowed")

    key = (hostname.strip().strip("[]").lower().rstrip("."), port)
    now = time.monotonic()

    if use_cache:
        cached = _cache_get(key, now)
        if cached is not None:
            allowed, reason = cached
            if allowed:
                return
            raise InsecureConnectionError(url, reason or "blocked by policy")

    try:
        await resolve_global_addresses(hostname, port)
    except InsecureConnectionError as exc:
        if use_cache:
            _cache_put(key, exc.reason, now)
        raise

    if use_cache:
        _cache_put(key, None, now)


async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, asyncio.IncompleteReadError):
        pass
    finally:
        if not writer.is_closing():
            try:
                writer.write_eof()
            except (OSError, RuntimeError):
                pass


class SsrfGuardProxy:
    """Loopback HTTP/HTTPS forward proxy that enforces the SSRF policy."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self._host = host
        self._requested_port = port
        self._server: asyncio.AbstractServer | None = None
        self.port: int = 0
        self.blocked_count = 0
        self._client_tasks: set[asyncio.Task[None]] = set()
        self._client_writers: set[asyncio.StreamWriter] = set()

    def _accept_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.create_task(self._handle_client(reader, writer))
        self._client_tasks.add(task)
        task.add_done_callback(self._client_tasks.discard)

    async def start(self) -> int:
        self._server = await asyncio.start_server(
            self._accept_client, self._host, self._requested_port
        )
        self.port = self._server.sockets[0].getsockname()[1]
        logger.info("SSRF guard proxy listening on %s:%s", self._host, self.port)
        return self.port

    async def stop(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.close()
        for writer in list(self._client_writers):
            if not writer.is_closing():
                writer.close()
        tasks = list(self._client_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._client_tasks.clear()
        if server is not None:
            await server.wait_closed()
        for writer in list(self._client_writers):
            try:
                await writer.wait_closed()
            except (ConnectionResetError, BrokenPipeError, OSError):
                pass
        self._client_writers.clear()

    async def _deny(
        self, writer: asyncio.StreamWriter, target: str, reason: str
    ) -> None:
        self.blocked_count += 1
        logger.warning("SSRF guard blocked %s: %s", target, reason)
        body = b"Blocked: target violates SSRF policy"
        writer.write(
            b"HTTP/1.1 403 Forbidden\r\n"
            b"Content-Type: text/plain\r\n"
            b"Content-Length: " + str(len(body)).encode() + b"\r\n"
            b"Connection: close\r\n\r\n" + body
        )
        try:
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass

    async def _connect_validated(
        self, hostname: str, port: int
    ) -> Tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        """Dial the exact address that passed validation (no re-resolution)."""
        addresses = await resolve_global_addresses(hostname, port)
        last_error: Exception | None = None
        for _family, address in addresses:
            try:
                # Per-address, and deliberately short: a name with several A
                # records would otherwise stack one full timeout per record and
                # stall the page far past its navigation budget.
                return await asyncio.wait_for(
                    asyncio.open_connection(host=address, port=port), timeout=10
                )
            except (OSError, asyncio.TimeoutError) as exc:
                last_error = exc
        raise InsecureConnectionError(
            hostname, f"could not connect to any validated address: {last_error}"
        )

    async def _handle_client(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._client_writers.add(writer)
        upstream_writer: asyncio.StreamWriter | None = None
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=30)
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError,
                asyncio.TimeoutError, ConnectionResetError):
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionResetError, BrokenPipeError, OSError):
                pass
            self._client_writers.discard(writer)
            return

        try:
            request_line, _, header_block = head.partition(b"\r\n")
            parts = request_line.decode("latin-1").split()
            if len(parts) != 3:
                await self._deny(writer, "<malformed>", "malformed request line")
                return
            method, target, version = parts

            if method.upper() == "CONNECT":
                host, _, raw_port = target.rpartition(":")
                host = host.strip("[]")
                try:
                    port = int(raw_port)
                except ValueError:
                    await self._deny(writer, target, "malformed CONNECT target")
                    return
                if port not in ALLOWED_PORTS:
                    await self._deny(writer, target, f"port {port} is not allowed")
                    return

                upstream_reader, upstream_writer = await self._connect_validated(
                    host, port
                )
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
                await asyncio.gather(
                    _pump(reader, upstream_writer),
                    _pump(upstream_reader, writer),
                    return_exceptions=True,
                )
                return

            # Plain HTTP arrives in absolute form: `GET http://host/path HTTP/1.1`
            split = urlsplit(target)
            if split.scheme not in ALLOWED_SCHEMES or not split.hostname:
                await self._deny(writer, target, "unsupported or malformed absolute URI")
                return
            port = split.port or (443 if split.scheme == "https" else 80)
            if port not in ALLOWED_PORTS:
                await self._deny(writer, target, f"port {port} is not allowed")
                return

            upstream_reader, upstream_writer = await self._connect_validated(
                split.hostname, port
            )

            origin_form = split.path or "/"
            if split.query:
                origin_form += "?" + split.query
            rebuilt = f"{method} {origin_form} {version}\r\n".encode("latin-1")

            # Drop hop-by-hop proxy headers before forwarding.
            forwarded_headers = b"\r\n".join(
                line
                for line in header_block.split(b"\r\n")
                if not line.lower().startswith(b"proxy-connection:")
            )
            upstream_writer.write(rebuilt + forwarded_headers)
            await upstream_writer.drain()

            await asyncio.gather(
                _pump(reader, upstream_writer),
                _pump(upstream_reader, writer),
                return_exceptions=True,
            )
        except InsecureConnectionError as exc:
            await self._deny(writer, exc.blocked_url, exc.reason)
        except Exception as exc:  # noqa: BLE001 - proxy must never crash the service
            logger.warning("SSRF guard proxy error: %s", exc)
            try:
                await self._deny(writer, "<error>", str(exc))
            except Exception:  # noqa: BLE001
                pass
        finally:
            for w in (upstream_writer, writer):
                if w is not None and not w.is_closing():
                    try:
                        w.close()
                    except Exception:  # noqa: BLE001
                        pass
            self._client_writers.discard(writer)
