import { Browser, chromium } from 'playwright';

export type BrowserLauncher = () => Promise<Browser>;

const defaultLauncher: BrowserLauncher = () =>
  chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  });

export interface BrowserLifecycle {
  ensureBrowser: () => Promise<Browser>;
  current: () => Browser | null;
  /**
   * Drops the slot when it still holds `instance`, so the next `ensureBrowser`
   * launches instead of handing back a browser the caller already saw fail.
   * Passing the instance keeps a concurrent replacement from being discarded.
   */
  invalidate: (instance: Browser) => void;
  /** Closes the held browser, if any, and empties the slot. */
  shutdown: () => Promise<void>;
}

/**
 * Holds one browser instance and replaces it when the process behind it exits.
 *
 * A browser that crashed keeps its object alive, so `if (!browser)` misses it and
 * every later request reuses a dead handle. The guard here is `isConnected()`, and
 * the `disconnected` listener clears the slot so the next call launches again.
 *
 * The launcher is a parameter so tests can drive startup without a real Chromium,
 * which is the only way to observe two callers sharing one launch.
 */
export function createBrowserLifecycle(
  launch: BrowserLauncher = defaultLauncher,
): BrowserLifecycle {
  let browser: Browser | null = null;
  let browserInitPromise: Promise<Browser> | null = null;

  const ensureBrowser = async (): Promise<Browser> => {
    if (browser && browser.isConnected()) {
      return browser;
    }

    if (!browserInitPromise) {
      browserInitPromise = (async () => {
        try {
          if (browser) {
            try {
              await browser.close().catch(() => {});
            } catch (_) {}
            browser = null;
          }

          const newBrowser = await launch();

          newBrowser.on('disconnected', () => {
            console.warn('Browser disconnected, invalidating active instance');
            if (browser === newBrowser) {
              browser = null;
            }
          });

          browser = newBrowser;
          return newBrowser;
        } finally {
          browserInitPromise = null;
        }
      })();
    }

    return browserInitPromise;
  };

  return {
    ensureBrowser,
    current: () => browser,
    invalidate: (instance: Browser) => {
      if (browser === instance) {
        browser = null;
      }
    },
    shutdown: async () => {
      // A launch already in flight will assign `browser` after this point, so
      // closing only what the slot holds now would leave that one running with
      // nothing left to close it.
      if (browserInitPromise) {
        await browserInitPromise.catch(() => {});
      }
      if (browser) {
        const current = browser;
        browser = null;
        await current.close().catch(() => {});
      }
    },
  };
}
