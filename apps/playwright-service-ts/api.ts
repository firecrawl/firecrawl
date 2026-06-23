import express, { Request, Response } from 'express';
import {
  chromium,
  Browser,
  BrowserContext,
  Route,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
  Page,
} from 'playwright';
import dotenv from 'dotenv';
import UserAgent from 'user-agents';
import { getError } from './helpers/get_error';
import { startSsrfProxy } from './helpers/ssrf_proxy';

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
const DISABLE_SSRF_PROXY =
  (process.env.DISABLE_SSRF_PROXY || 'False').toUpperCase() === 'TRUE';

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

let ssrfProxyUrl: string | null = null;

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
      '--disable-pdf-extension',
    ],
  });
};

const createContext = async (
  skipTlsVerification: boolean = false,
  userAgentOverride?: string,
): Promise<BrowserContext> => {
  const userAgent = userAgentOverride || new UserAgent().toString();
  const viewport = { width: 1280, height: 800 };

  const contextOptions: any = {
    userAgent,
    viewport,
    ignoreHTTPSErrors: skipTlsVerification,
    serviceWorkers: 'block',
  };

  if (PROXY_SERVER && PROXY_USERNAME && PROXY_PASSWORD) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
      username: PROXY_USERNAME,
      password: PROXY_PASSWORD,
    };
  } else if (PROXY_SERVER) {
    contextOptions.proxy = {
      server: PROXY_SERVER,
    };
  } else if (ssrfProxyUrl) {
    contextOptions.proxy = { server: ssrfProxyUrl };
  }

  const newContext = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await newContext.route(
      '**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}',
      async (route: Route) => {
        await route.abort();
      },
    );
  }

  await newContext.route(
    '**/*',
    async (route: Route, request: PlaywrightRequest) => {
      const hostname = new URL(request.url()).hostname.toLowerCase();
      if (AD_SERVING_DOMAINS.some((domain) => hostname.includes(domain))) {
        return route.abort();
      }
      return route.continue();
    },
  );

  return newContext;
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
) => {
  console.log(
    `Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`,
  );

  let navResponse: PlaywrightResponse | null = null;
  const onResponse = (resp: PlaywrightResponse) => {
    if (navResponse) return;
    const req = resp.request();
    if (req.frame() === page.mainFrame() && req.isNavigationRequest()) {
      navResponse = resp;
    }
  };
  page.on('response', onResponse);

  let downloadBytes: Promise<Buffer> | undefined;
  page.once('download', async (download) => {
    downloadBytes = download
      .createReadStream()
      .then(async (stream) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return Buffer.concat(chunks);
      })
      .finally(() => download.delete().catch(() => undefined));
  });

  let gotoError: unknown;
  let response: PlaywrightResponse | null = null;
  try {
    response = await page.goto(url, { waitUntil, timeout });
  } catch (error) {
    gotoError = error;
  }

  try {
    const finalResponse = response ?? navResponse;
    if (!finalResponse && !downloadBytes) {
      throw gotoError ?? new Error('No response captured');
    }

    const headers = finalResponse ? await finalResponse.allHeaders() : {};
    const ct = Object.entries(headers).find(
      ([k]) => k.toLowerCase() === 'content-type',
    )?.[1];
    const isHtml = !!ct && ct.toLowerCase().includes('text/html');
    const status = finalResponse?.status() ?? 200;

    let bytes: Buffer;
    if (downloadBytes) {
      bytes = await downloadBytes;
    } else if (isHtml && !gotoError) {
      if (waitAfterLoad > 0) await page.waitForTimeout(waitAfterLoad);
      if (checkSelector) {
        try {
          await page.waitForSelector(checkSelector, { timeout });
        } catch {
          throw new Error('Required selector not found');
        }
      }
      bytes = Buffer.from(await page.content(), 'utf8');
    } else {
      const apiResp = await page
        .context()
        .request.get(url, { maxRedirects: 20 });
      bytes = await apiResp.body();
    }

    return {
      content: bytes.toString('base64'),
      status,
      headers,
      contentType: ct,
    };
  } finally {
    page.off('response', onResponse);
  }
};

app.get('/health', async (req: Request, res: Response) => {
  try {
    if (!browser) {
      await initializeBrowser();
    }

    const testContext = await createContext();
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
  let page: Page | null = null;

  try {
    const userAgentOverride = headers
      ? Object.entries(headers).find(
          ([k]) => k.toLowerCase() === 'user-agent',
        )?.[1]
      : undefined;

    requestContext = await createContext(
      skip_tls_verification,
      userAgentOverride,
    );
    page = await requestContext.newPage();

    if (headers) {
      const filteredHeaders = Object.fromEntries(
        Object.entries(headers).filter(
          ([k]) => k.toLowerCase() !== 'user-agent',
        ),
      );
      if (Object.keys(filteredHeaders).length > 0) {
        await requestContext.setExtraHTTPHeaders(filteredHeaders);
      }
    }

    const result = await scrapePage(
      page,
      url,
      'load',
      wait_after_load,
      timeout,
      check_selector,
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
      ...(pageError && { pageError }),
    });
  } catch (error) {
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

const initializeSsrfProxy = async () => {
  if (PROXY_SERVER || DISABLE_SSRF_PROXY) return;
  const proxy = await startSsrfProxy();
  ssrfProxyUrl = proxy.url;
  console.log(`SSRF-filtering proxy listening at ${proxy.url}`);
};

app.listen(port, async () => {
  await initializeSsrfProxy();
  await initializeBrowser();
  console.log(`Server is running on port ${port}`);
});

if (require.main === module) {
  process.on('SIGINT', () => {
    shutdownBrowser().then(() => {
      console.log('Browser closed');
      process.exit(0);
    });
  });
}
