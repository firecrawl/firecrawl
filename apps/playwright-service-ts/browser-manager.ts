import type { Browser } from 'playwright';

export const createBrowserManager = (launch: () => Promise<Browser>) => {
  let browser: Browser | undefined;
  let launching: Promise<Browser> | undefined;

  const getBrowser = async (): Promise<Browser> => {
    if (browser?.isConnected()) return browser;
    browser = undefined;

    if (!launching) {
      const pending = Promise.resolve().then(launch);
      launching = pending;

      try {
        const launched = await pending;
        launched.on('disconnected', () => {
          if (browser === launched) browser = undefined;
        });
        if (!launched.isConnected()) {
          throw new Error('Browser disconnected during startup');
        }
        browser = launched;
        return launched;
      } finally {
        if (launching === pending) launching = undefined;
      }
    }

    return launching;
  };

  const closeBrowser = async (): Promise<void> => {
    const current = browser;
    browser = undefined;
    if (current) await current.close();
  };

  return { getBrowser, closeBrowser };
};
