import { Browser } from 'playwright';

export interface BrowserManagerOptions {
  launcher: () => Promise<Browser>;
  onDisconnect?: () => void;
  logger?: {
    warn: (message: string, ...args: any[]) => void;
    error: (message: string, ...args: any[]) => void;
  };
}

export function isBrowserConnected(browser?: Browser | null): boolean {
  if (!browser) return false;
  try {
    return typeof browser.isConnected === 'function' ? browser.isConnected() : true;
  } catch {
    return false;
  }
}

export function isTargetClosedError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && error !== null) {
    const err = error as { name?: string; message?: string };
    if (err.name === 'TargetClosedError') return true;
    if (typeof err.message === 'string' && (
      err.message.includes('Target page, context or browser has been closed') ||
      err.message.includes('Target closed') ||
      err.message.includes('browser has been closed')
    )) {
      return true;
    }
  }
  return false;
}

export interface BrowserManager {
  ensureBrowser: () => Promise<Browser>;
  getBrowser: () => Browser | null;
  isReady: () => boolean;
  handleError: (error: unknown) => boolean;
  reset: () => void;
}

export function createBrowserManager(options: BrowserManagerOptions): BrowserManager {
  let activeBrowser: Browser | null = null;
  let initPromise: Promise<Browser> | null = null;
  const logger = options.logger ?? console;

  const reset = () => {
    activeBrowser = null;
    initPromise = null;
  };

  const handleDisconnect = () => {
    logger.warn('⚠️ Playwright browser disconnected. Invalidation scheduled.');
    reset();
    if (options.onDisconnect) {
      try {
        options.onDisconnect();
      } catch (err) {
        logger.error('Error in onDisconnect callback:', err);
      }
    }
  };

  const ensureBrowser = async (): Promise<Browser> => {
    if (activeBrowser && isBrowserConnected(activeBrowser)) {
      return activeBrowser;
    }

    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      try {
        const browser = await options.launcher();
        activeBrowser = browser;

        if (typeof browser.on === 'function') {
          browser.on('disconnected', handleDisconnect);
        }

        return browser;
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  };

  const handleError = (error: unknown): boolean => {
    if (isTargetClosedError(error) || (activeBrowser && !isBrowserConnected(activeBrowser))) {
      logger.warn('⚠️ Browser closed or TargetClosedError encountered. Resetting active browser instance.');
      reset();
      return true;
    }
    return false;
  };

  return {
    ensureBrowser,
    getBrowser: () => activeBrowser,
    isReady: () => isBrowserConnected(activeBrowser),
    handleError,
    reset,
  };
}
