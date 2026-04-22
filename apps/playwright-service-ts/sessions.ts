import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { randomUUID } from 'crypto';
import net from 'net';

export type SessionCreateResult = {
  id: string;
  cdp_url: string;
  expires_at: string;
};

export type SessionSnapshotResult = {
  content: string;
  pageStatusCode: number;
  url: string;
};

type SessionHandle = {
  id: string;
  browser: Browser;
  externalPort: number;
  internalPort: number;
  relay: net.Server | null;
  createdAt: number;
  lastActivity: number;
  expiresAt: number;
  idleTimer: NodeJS.Timeout;
};

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_MAX_SESSIONS = 5;

const IDLE_TTL_MS = Math.max(
  30_000,
  Number.parseInt(process.env.LOCAL_BROWSER_IDLE_TTL_MS ?? '', 10) || DEFAULT_IDLE_TTL_MS,
);
const MAX_SESSIONS = Math.max(
  1,
  Number.parseInt(process.env.LOCAL_BROWSER_MAX_SESSIONS ?? '', 10) || DEFAULT_MAX_SESSIONS,
);
const CDP_PUBLIC_HOST = process.env.PLAYWRIGHT_CDP_PUBLIC_HOST || 'localhost';

// Optional constrained port range for CDP. When both are set, sessions pick
// ports only from [start, end]; this lets Docker-compose deployments publish
// a fixed range and have CDP URLs be reachable from the host. When unset,
// fall back to OS-assigned ports (listen(0)) for bare-metal deployments.
const PORT_RANGE_START = (() => {
  const n = Number.parseInt(process.env.LOCAL_BROWSER_PORT_RANGE_START ?? '', 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
})();
const PORT_RANGE_END = (() => {
  const n = Number.parseInt(process.env.LOCAL_BROWSER_PORT_RANGE_END ?? '', 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
})();
const PORT_RANGE_ENABLED =
  PORT_RANGE_START !== null &&
  PORT_RANGE_END !== null &&
  PORT_RANGE_END >= PORT_RANGE_START;

const sessions = new Map<string, SessionHandle>();
const allocatedPorts = new Set<number>();

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session ${id} not found`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionCapacityError extends Error {
  constructor(reason: number | string) {
    const message =
      typeof reason === 'number'
        ? `Maximum concurrent local browser sessions reached (${reason})`
        : reason;
    super(message);
    this.name = 'SessionCapacityError';
  }
}

async function tryBindPort(port: number): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => {
      resolve(false);
    });
    srv.listen(port, '0.0.0.0', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function getFreePortInRange(
  start: number,
  end: number,
): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (allocatedPorts.has(port)) continue;
    if (await tryBindPort(port)) {
      return port;
    }
  }
  throw new SessionCapacityError(
    `No free port available in LOCAL_BROWSER_PORT_RANGE [${start}-${end}]`,
  );
}

async function getOsAssignedFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not allocate a free port')));
      }
    });
  });
}

/**
 * Pick the externally reachable port that the returned ``cdp_url`` will
 * expose. When a port range is configured (typically in Docker where that
 * range is published to the host), we pick from the range. Otherwise we
 * return ``null`` to indicate "use the Chrome-internal port as-is", which
 * works on bare metal where 127.0.0.1 is the same machine as the client.
 */
async function getExternalPort(): Promise<number | null> {
  if (!PORT_RANGE_ENABLED) return null;
  return getFreePortInRange(PORT_RANGE_START!, PORT_RANGE_END!);
}

/**
 * Start a TCP relay that accepts connections on 0.0.0.0:externalPort and
 * forwards them to 127.0.0.1:internalPort. Needed because
 * ``chrome-headless-shell`` (the variant bundled with Playwright) ignores
 * ``--remote-debugging-address`` and only binds CDP to 127.0.0.1 -- so a
 * Docker-published port would otherwise reset connections. This relay
 * is transparent at the TCP layer, so WebSocket upgrades for CDP work
 * seamlessly.
 */
function startCdpRelay(
  externalPort: number,
  internalPort: number,
): Promise<net.Server> {
  return new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer(clientSocket => {
      const upstream = net.createConnection(
        { port: internalPort, host: '127.0.0.1' },
        () => {
          clientSocket.pipe(upstream);
          upstream.pipe(clientSocket);
        },
      );
      const onClose = () => {
        try {
          clientSocket.destroy();
        } catch {}
        try {
          upstream.destroy();
        } catch {}
      };
      clientSocket.on('error', onClose);
      clientSocket.on('end', onClose);
      clientSocket.on('close', onClose);
      upstream.on('error', onClose);
      upstream.on('end', onClose);
      upstream.on('close', onClose);
    });
    server.unref();
    server.once('error', reject);
    server.listen(externalPort, '0.0.0.0', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

async function waitForCdpReady(
  port: number,
  timeoutMs = 10_000,
  probeIntervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>(resolve => {
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      const done = (ok: boolean) => {
        try {
          sock.destroy();
        } catch {}
        resolve(ok);
      };
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
      sock.setTimeout(500, () => done(false));
    });
    if (ready) return;
    await new Promise(r => setTimeout(r, probeIntervalMs));
  }
  throw new Error(
    `Chrome CDP on 127.0.0.1:${port} did not become reachable within ${timeoutMs}ms`,
  );
}

function touch(session: SessionHandle) {
  session.lastActivity = Date.now();
  session.expiresAt = session.lastActivity + IDLE_TTL_MS;
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    void deleteSession(session.id).catch(err => {
      console.warn(`Failed to auto-expire session ${session.id}:`, err);
    });
  }, IDLE_TTL_MS);
  session.idleTimer.unref?.();
}

export async function createSession(): Promise<SessionCreateResult> {
  if (sessions.size >= MAX_SESSIONS) {
    throw new SessionCapacityError(MAX_SESSIONS);
  }

  // External port: what the cdp_url returned to clients will expose.
  // Internal port: where Chrome actually listens (127.0.0.1-only when using
  // chrome-headless-shell). If no external range is configured (bare metal),
  // client and Chrome share the same port via 127.0.0.1/localhost.
  const externalPort = await getExternalPort();
  if (externalPort !== null) {
    allocatedPorts.add(externalPort);
  }
  const internalPort = await getOsAssignedFreePort();

  const id = randomUUID();

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        `--remote-debugging-port=${internalPort}`,
        // Kept for completeness; chrome-headless-shell ignores this and
        // binds to 127.0.0.1 regardless, which is why we use a relay below.
        '--remote-debugging-address=0.0.0.0',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });
  } catch (err) {
    if (externalPort !== null) allocatedPorts.delete(externalPort);
    throw err;
  }

  // Wait for Chrome's CDP to be reachable on the internal port, then (in
  // Docker-range mode) start a TCP relay that exposes it on the external
  // port so Docker-published traffic on 0.0.0.0:<externalPort> reaches
  // Chrome at 127.0.0.1:<internalPort>.
  let relay: net.Server | null = null;
  try {
    await waitForCdpReady(internalPort);
    if (externalPort !== null) {
      relay = await startCdpRelay(externalPort, internalPort);
    }
  } catch (err) {
    if (externalPort !== null) allocatedPorts.delete(externalPort);
    try {
      await browser.close();
    } catch {}
    throw err;
  }

  let context: BrowserContext;
  if (browser.contexts().length > 0) {
    context = browser.contexts()[0];
  } else {
    context = await browser.newContext();
  }
  if (context.pages().length === 0) {
    await context.newPage();
  }

  const now = Date.now();
  const expiresAtMs = now + IDLE_TTL_MS;
  const publicPort = externalPort !== null ? externalPort : internalPort;
  const handle: SessionHandle = {
    id,
    browser,
    externalPort: publicPort,
    internalPort,
    relay,
    createdAt: now,
    lastActivity: now,
    expiresAt: expiresAtMs,
    idleTimer: setTimeout(() => {
      void deleteSession(id).catch(err => {
        console.warn(`Failed to auto-expire session ${id}:`, err);
      });
    }, IDLE_TTL_MS),
  };
  handle.idleTimer.unref?.();

  browser.on('disconnected', () => {
    const existing = sessions.get(id);
    if (existing) {
      clearTimeout(existing.idleTimer);
      sessions.delete(id);
      if (PORT_RANGE_ENABLED) {
        allocatedPorts.delete(existing.externalPort);
      }
      if (existing.relay) {
        try {
          existing.relay.close();
        } catch {}
      }
    }
  });

  sessions.set(id, handle);

  return {
    id,
    cdp_url: `http://${CDP_PUBLIC_HOST}:${publicPort}`,
    expires_at: new Date(expiresAtMs).toISOString(),
  };
}

export async function snapshotSession(
  id: string,
): Promise<SessionSnapshotResult> {
  const session = sessions.get(id);
  if (!session) {
    throw new SessionNotFoundError(id);
  }

  // The remote Chromium may already be gone -- for example, a CDP client
  // called browser.close() over the connectOverCDP connection, which sends
  // a Browser.close CDP command that terminates the remote process. Close
  // the race between that teardown and the `browser.on('disconnected')`
  // handler by short-circuiting to a clean 404 instead of hanging or
  // returning an about:blank snapshot from a freshly-created empty context.
  if (!session.browser.isConnected()) {
    clearTimeout(session.idleTimer);
    sessions.delete(id);
    if (PORT_RANGE_ENABLED) {
      allocatedPorts.delete(session.externalPort);
    }
    if (session.relay) {
      try {
        session.relay.close();
      } catch {}
    }
    throw new SessionNotFoundError(id);
  }

  touch(session);

  const contexts = session.browser.contexts();
  let context: BrowserContext;
  if (contexts.length > 0) {
    context = contexts[0];
  } else {
    context = await session.browser.newContext();
  }

  const pages = context.pages();
  let page: Page;
  if (pages.length > 0) {
    page = pages[0];
  } else {
    page = await context.newPage();
  }

  const content = await page.content();
  const url = page.url();

  return {
    content,
    pageStatusCode: 200,
    url,
  };
}

export async function deleteSession(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) {
    return false;
  }
  sessions.delete(id);
  if (PORT_RANGE_ENABLED) {
    allocatedPorts.delete(session.externalPort);
  }
  clearTimeout(session.idleTimer);
  if (session.relay) {
    try {
      session.relay.close();
    } catch {}
  }
  // Skip browser.close() when the remote Chromium is already gone (e.g. a
  // CDP client wiped it). Calling close() on a disconnected browser can
  // throw or hang; the disconnect handler has already fired or will fire
  // on its own.
  if (session.browser.isConnected()) {
    try {
      await session.browser.close();
    } catch (err) {
      console.warn(`Error closing browser for session ${id}:`, err);
    }
  }
  return true;
}

export async function shutdownAllSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.allSettled(ids.map(id => deleteSession(id)));
}

export function getSessionCount(): number {
  return sessions.size;
}
