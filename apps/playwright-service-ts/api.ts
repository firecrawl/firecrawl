import express, { Request, Response } from 'express';
import {
  chromium,
  Browser,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Page,
  Response as PlaywrightResponse,
} from 'playwright';
import { Script } from 'vm';
import dotenv from 'dotenv';
import UserAgent from 'user-agents';
import { getError } from './helpers/get_error';
import { Server } from 'proxy-chain';
import { isInternalHost, ssrfPrepareRequest } from './helpers/ssrf';

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(express.json());

const BLOCK_MEDIA =
  (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';
const MAX_CONCURRENT_PAGES = Math.max(
  1,
  Number.parseInt(process.env.MAX_CONCURRENT_PAGES ?? '10', 10) || 10,
);
const ALLOW_LOCAL_WEBHOOKS =
  (process.env.ALLOW_LOCAL_WEBHOOKS || 'False').toUpperCase() === 'TRUE';

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

class InsecureConnectionError extends Error {
  constructor(
    public readonly blockedUrl: string,
    reason: string,
  ) {
    super(`Blocked insecure target URL "${blockedUrl}": ${reason}`);
    this.name = 'InsecureConnectionError';
  }
}

const assertSafeTargetUrl = async (urlString: string): Promise<void> => {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    throw new InsecureConnectionError(urlString, 'URL is invalid');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new InsecureConnectionError(
      urlString,
      `unsupported protocol "${parsedUrl.protocol}"`,
    );
  }
  if (!ALLOW_LOCAL_WEBHOOKS && (await isInternalHost(parsedUrl.hostname))) {
    throw new InsecureConnectionError(
      urlString,
      'resolves to a private/internal address',
    );
  }
};

const buildUpstreamProxyUrl = (): string | undefined => {
  if (!PROXY_SERVER) return undefined;
  const server = PROXY_SERVER.includes('://')
    ? PROXY_SERVER
    : `http://${PROXY_SERVER}`;
  const url = new URL(server);
  if (PROXY_USERNAME) url.username = PROXY_USERNAME;
  if (PROXY_PASSWORD) url.password = PROXY_PASSWORD;
  return url.toString();
};

const startSSRFProxy = async (): Promise<number> => {
  const server = new Server({
    port: 0,
    host: '127.0.0.1',
    prepareRequestFunction: ssrfPrepareRequest({
      allowLocal: ALLOW_LOCAL_WEBHOOKS,
      upstreamProxyUrl: buildUpstreamProxyUrl(),
    }),
  });
  await server.listen();
  return server.port;
};

let ssrfProxyPort: number;

type ContextSecurityState = {
  blockedNavigationRequestUrl: string | null;
};
class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    if (this.queue.length > 0) {
      const nextResolve = this.queue.shift();
      if (nextResolve) {
        this.permits--;
        nextResolve();
      }
    }
  }

  getAvailablePermits(): number {
    return this.permits;
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}
const pageSemaphore = new Semaphore(MAX_CONCURRENT_PAGES);

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com',
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  skip_tls_verification?: boolean;
  screenshot?: ScreenshotOptions;
  actions?: Action[];
}

type ScreenshotOptions = {
  fullPage?: boolean;
  viewport?: { width: number; height: number };
};
type Action = ScreenshotOptions & { type: string; [key: string]: any };
type ActionResults = {
  screenshots: string[];
  scrapes: { url: string; html: string }[];
  javascriptReturns: { type: string; value: unknown }[];
};

class ActionFailedError extends Error {}

const takeScreenshot = async (
  page: Page,
  { fullPage, viewport }: ScreenshotOptions,
): Promise<string> => {
  if (viewport) await page.setViewportSize(viewport);
  return (await page.screenshot({ fullPage: !!fullPage })).toString('base64');
};

// "return document.title" is a function body, not a script. Compiling it
// here, without running it, picks the form, so the page runs it once.
const parsesAsScript = (script: string) => {
  try {
    new Script(script);
    return true;
  } catch {
    return false;
  }
};

// All actions share the scrape's deadline. Element waits also stop at 10s,
// so a missing selector fails its action, not the whole scrape later.
const runActions = async (
  page: Page,
  actions: Action[],
  deadline: number,
): Promise<ActionResults> => {
  const results: ActionResults = {
    screenshots: [],
    scrapes: [],
    javascriptReturns: [],
  };
  const timeLeft = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('past the scrape timeout');
    return ms;
  };
  for (const [i, action] of actions.entries()) {
    try {
      const timeout = Math.min(timeLeft(), 10000);
      switch (action.type) {
        case 'wait': {
          const ms = action.milliseconds ?? 0;
          if (action.selector) {
            await page.waitForSelector(action.selector, { timeout });
          } else if (ms > timeLeft()) {
            throw new Error(`${ms} ms is past the scrape timeout`);
          } else {
            await page.waitForTimeout(ms);
          }
          break;
        }
        case 'click': {
          const target = page.locator(action.selector);
          for (const el of action.all ? await target.all() : [target.first()]) {
            await el.click({ timeout });
          }
          await page.waitForLoadState('load', { timeout });
          break;
        }
        case 'write':
          await page.keyboard.type(action.text);
          break;
        case 'press':
          await page.keyboard.press(action.key);
          break;
        case 'scroll': {
          const dy = action.direction === 'up' ? -1 : 1;
          if (action.selector) {
            await page
              .locator(action.selector)
              .first()
              .evaluate((el, d) => el.scrollBy(0, d * el.clientHeight), dy, {
                timeout,
              });
          } else {
            await page.evaluate((d) => window.scrollBy(0, d * innerHeight), dy);
          }
          break;
        }
        case 'screenshot':
          results.screenshots.push(await takeScreenshot(page, action));
          break;
        case 'scrape':
          results.scrapes.push({ url: page.url(), html: await page.content() });
          break;
        case 'executeJavascript': {
          const { script } = action;
          const value = await page.evaluate(
            parsesAsScript(script) ? script : `(async () => { ${script} })()`,
          );
          results.javascriptReturns.push({ type: typeof value, value });
          break;
        }
        default:
          throw new Error('unsupported action type');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ActionFailedError(`action ${i} (${action.type}): ${reason}`);
    }
  }
  return results;
};

let browser: Browser;

const initializeBrowser = async () => {
  browser = await chromium.launch({
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
};

const createContext = async (
  skipTlsVerification: boolean = false,
  userAgentOverride?: string,
): Promise<{
  context: BrowserContext;
  securityState: ContextSecurityState;
}> => {
  const userAgent = userAgentOverride || new UserAgent().toString();
  const viewport = { width: 1280, height: 800 };
  const securityState: ContextSecurityState = {
    blockedNavigationRequestUrl: null,
  };

  const contextOptions: any = {
    userAgent,
    viewport,
    ignoreHTTPSErrors: skipTlsVerification,
    serviceWorkers: 'block',
  };

  contextOptions.proxy = {
    server: `http://127.0.0.1:${ssrfProxyPort}`,
  };

  const newContext = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await newContext.route(
      '**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}',
      async (route: Route, request: PlaywrightRequest) => {
        await route.abort();
      },
    );
  }

  // Intercept all requests to avoid loading ads
  await newContext.route(
    '**/*',
    async (route: Route, request: PlaywrightRequest) => {
      const requestUrlString = request.url();
      try {
        await assertSafeTargetUrl(requestUrlString);
      } catch (error) {
        if (error instanceof InsecureConnectionError) {
          if (request.isNavigationRequest()) {
            securityState.blockedNavigationRequestUrl = requestUrlString;
          }
          console.warn(`Blocked request: ${requestUrlString}`);
          return route.abort('blockedbyclient');
        }
        throw error;
      }

      const hostname = new URL(requestUrlString).hostname.toLowerCase();

      if (AD_SERVING_DOMAINS.some((domain) => hostname.includes(domain))) {
        console.log(hostname);
        return route.abort();
      }
      return route.continue();
    },
  );

  return { context: newContext, securityState };
};

const shutdownBrowser = async () => {
  if (browser) {
    await browser.close();
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const scrapePage = async (
  page: Page,
  url: string,
  waitUntil: 'load' | 'networkidle',
  waitAfterLoad: number,
  timeout: number,
  checkSelector: string | undefined,
  securityState: ContextSecurityState,
  actions: Action[] | undefined,
  screenshot: ScreenshotOptions | undefined,
) => {
  console.log(
    `Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`,
  );
  const deadline = Date.now() + timeout;
  let response: PlaywrightResponse | null;
  try {
    response = await page.goto(url, { waitUntil, timeout });
  } catch (error) {
    if (securityState.blockedNavigationRequestUrl) {
      throw new InsecureConnectionError(
        securityState.blockedNavigationRequestUrl,
        'navigation to private/internal resource is not allowed',
      );
    }
    throw error;
  }

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error('Required selector not found');
    }
  }

  // Actions run before the content is read, so it shows the page they left.
  // A click that navigates replaces the response, so the status and headers
  // are the landed page's too.
  const onResponse = (r: PlaywrightResponse) => {
    if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) {
      response = r;
    }
  };
  let actionResults: ActionResults | undefined;
  if (actions?.length) {
    page.on('response', onResponse);
    try {
      actionResults = await runActions(page, actions, deadline);
    } finally {
      page.off('response', onResponse);
    }
  }
  const screenshotData = screenshot
    ? await takeScreenshot(page, screenshot)
    : undefined;

  let headers = null,
    content = await page.content(),
    landedUrl = page.url();
  let ct: string | undefined = undefined;
  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === 'content-type',
    )?.[1];
    if (
      ct &&
      (ct.toLowerCase().includes('application/json') ||
        ct.toLowerCase().includes('text/plain'))
    ) {
      content = (await response.body()).toString('utf8'); // TODO: determine real encoding
      landedUrl = response.url();
    }
  }

  return {
    content,
    // Where the returned content came from: page.url() for rendered HTML
    // (covers HTTP 3xx and client-side redirects), response.url() for raw
    // JSON/text bodies, which come from the page.goto response.
    url: landedUrl,
    status: response ? response.status() : null,
    headers,
    contentType: ct,
    screenshot: screenshotData,
    actions: actionResults,
  };
};

app.get('/health', async (req: Request, res: Response) => {
  try {
    if (!browser) {
      await initializeBrowser();
    }

    const { context: testContext } = await createContext();
    const testPage = await testContext.newPage();
    await testPage.close();
    await testContext.close();

    res.status(200).json({
      status: 'healthy',
      maxConcurrentPages: MAX_CONCURRENT_PAGES,
      activePages: MAX_CONCURRENT_PAGES - pageSemaphore.getAvailablePermits(),
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});

app.post('/scrape', async (req: Request, res: Response) => {
  const {
    url,
    wait_after_load = 0,
    timeout = 15000,
    headers,
    check_selector,
    skip_tls_verification = false,
    screenshot,
    actions,
  }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`Skip TLS Verification: ${skip_tls_verification}`);
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    await assertSafeTargetUrl(url);
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    throw error;
  }

  if (!PROXY_SERVER) {
    console.warn(
      '⚠️ WARNING: No proxy server provided. Your IP address may be blocked.',
    );
  }

  if (!browser) {
    await initializeBrowser();
  }

  await pageSemaphore.acquire();

  let requestContext: BrowserContext | null = null;
  let securityState: ContextSecurityState | null = null;
  let page: Page | null = null;

  try {
    // Extract user-agent from request headers (case-insensitive) so it can
    // be applied at the context level.  Playwright ignores user-agent in
    // setExtraHTTPHeaders when the context already defines one (#2802).
    const userAgentOverride = headers
      ? Object.entries(headers).find(
          ([k]) => k.toLowerCase() === 'user-agent',
        )?.[1]
      : undefined;

    const contextBundle = await createContext(
      skip_tls_verification,
      userAgentOverride,
    );
    requestContext = contextBundle.context;
    securityState = contextBundle.securityState;
    page = await requestContext.newPage();
    if (screenshot?.viewport) await page.setViewportSize(screenshot.viewport);

    if (headers) {
      // A Cookie header passed through setExtraHTTPHeaders is sent on the first
      // request but DROPPED on any redirect hop (the browser regenerates the
      // redirected request from its cookie jar, which is empty). Authenticated
      // sites that 302 (e.g. to /signin when the session looks absent) then
      // land on the login page. Seed the cookie jar instead so Chromium re-sends
      // it on every request, including redirects — matching what a raw HTTP
      // client does.
      const cookieHeader = Object.entries(headers).find(
        ([k]) => k.toLowerCase() === 'cookie',
      )?.[1];
      if (cookieHeader) {
        // Scope cookies to the registrable domain (e.g. ".example.com"), not
        // host-only. Authenticated pages often 302 across sibling subdomains
        // (example.com -> app.example.com); a host-only cookie set for the
        // original host would not be sent to the redirect target, leaving the
        // request unauthenticated. The Cookie header carries no domain info, so
        // we apply the eTLD+1 — broad enough to follow the redirect, and these
        // are first-party cookies being returned to their own origin anyway.
        let cookieDomain: string | undefined;
        try {
          const host = new URL(url).hostname;
          const labels = host.split('.');
          cookieDomain = labels.length > 2 ? labels.slice(-2).join('.') : host;
        } catch {
          cookieDomain = undefined;
        }
        type SeedCookie = {
          name: string;
          value: string;
          url?: string;
          domain?: string;
          path?: string;
        };
        const cookies = cookieHeader
          .split(';')
          .map((pair) => pair.trim())
          .filter(Boolean)
          .map((pair): SeedCookie | null => {
            const eq = pair.indexOf('=');
            if (eq === -1) return null;
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            return cookieDomain
              ? { name, value, domain: `.${cookieDomain}`, path: '/' }
              : { name, value, url };
          })
          .filter((c): c is SeedCookie => c !== null);
        if (cookies.length > 0) {
          try {
            await requestContext.addCookies(cookies);
          } catch (error) {
            console.warn('Failed to seed cookies from Cookie header:', error);
          }
        }
      }

      // Remove user-agent (already applied at the context level) and cookie
      // (now seeded into the jar) before forwarding the rest verbatim.
      const filteredHeaders = Object.fromEntries(
        Object.entries(headers).filter(([k]) => {
          const lower = k.toLowerCase();
          return lower !== 'user-agent' && lower !== 'cookie';
        }),
      );
      if (Object.keys(filteredHeaders).length > 0) {
        await page.setExtraHTTPHeaders(filteredHeaders);
      }
    }

    const result = await scrapePage(
      page,
      url,
      'load',
      wait_after_load,
      timeout,
      check_selector,
      securityState,
      actions,
      screenshot,
    );
    const pageError =
      result.status !== 200 ? getError(result.status) : undefined;

    if (!pageError) {
      console.log(`✅ Scrape successful!`);
    } else {
      console.log(
        `🚨 Scrape failed with status code: ${result.status} ${pageError}`,
      );
    }

    res.json({
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      url: result.url,
      ...(pageError && { pageError }),
      ...(result.screenshot && { screenshot: result.screenshot }),
      ...(result.actions && { actions: result.actions }),
    });
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
    }
    if (error instanceof ActionFailedError) {
      return res.json({ content: '', pageStatusCode: 200, actionError: error.message });
    }
    console.error('Scrape error:', error);
    res
      .status(500)
      .json({ error: 'An error occurred while fetching the page.' });
  } finally {
    if (page) await page.close();
    if (requestContext) await requestContext.close();
    pageSemaphore.release();
  }
});

const start = async () => {
  ssrfProxyPort = await startSSRFProxy();
  await initializeBrowser();
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
};
start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

if (require.main === module) {
  process.on('SIGINT', () => {
    shutdownBrowser().then(() => {
      console.log('Browser closed');
      process.exit(0);
    });
  });
}
