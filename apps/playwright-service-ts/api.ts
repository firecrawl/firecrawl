import express, { Request, Response } from 'express';
import { chromium, Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from 'playwright';
import dotenv from 'dotenv';
import UserAgent from 'user-agents';
import { getError } from './helpers/get_error';

dotenv.config();

const app = express();
const port = process.env.PORT || 3003;

app.use(express.json());

const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';
const MAX_CONCURRENT_PAGES = Math.max(1, Number.parseInt(process.env.MAX_CONCURRENT_PAGES ?? '10', 10) || 10);

const PROXY_SERVER = process.env.PROXY_SERVER || null;
const PROXY_USERNAME = process.env.PROXY_USERNAME || null;
const PROXY_PASSWORD = process.env.PROXY_PASSWORD || null;

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
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
  'amazon-adsystem.com'
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
      '--disable-gpu'
    ]
  });
};

const createContext = async (skipTlsVerification = false) => {
  const userAgent = new UserAgent().toString();

  const contextOptions: any = {
    userAgent,
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: skipTlsVerification,
  };

  if (PROXY_SERVER) {
    contextOptions.proxy = PROXY_USERNAME && PROXY_PASSWORD
      ? { server: PROXY_SERVER, username: PROXY_USERNAME, password: PROXY_PASSWORD }
      : { server: PROXY_SERVER };
  }

  const context = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await context.route('**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}', route => route.abort());
  }

  await context.route('**/*', (route, request) => {
    const hostname = new URL(request.url()).hostname;
    if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      return route.abort();
    }
    return route.continue();
  });

  return context;
};

const scrapePage = async (
  page: Page,
  url: string,
  waitUntil: 'load' | 'networkidle',
  waitAfterLoad: number,
  timeout: number,
  checkSelector?: string
) => {
  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, {
        state: 'visible',   // ✅ FIX
        timeout,
      });
    } catch {
      throw new Error('Required selector not found or not visible');
    }
  }

  let content = await page.content();
  let headers = null;
  let ct: string | undefined;

  if (response) {
    headers = await response.allHeaders();
    ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1];
    if (ct && (ct.includes('application/json') || ct.includes('text/plain'))) {
      content = (await response.body()).toString('utf8');
    }
  }

  return {
    content,
    status: response?.status() ?? null,
    headers,
    contentType: ct,
  };
};

app.post('/scrape', async (req: Request, res: Response) => {
  const { url, wait_after_load = 0, timeout = 15000, headers, check_selector, skip_tls_verification = false }: UrlModel = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  if (!browser) await initializeBrowser();
  await pageSemaphore.acquire();

  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await createContext(skip_tls_verification);
    page = await context.newPage();

    if (headers) await page.setExtraHTTPHeaders(headers);

    const result = await scrapePage(page, url, 'load', wait_after_load, timeout, check_selector);
    const pageError = result.status !== 200 ? getError(result.status) : undefined;

    res.json({
      content: result.content,
      pageStatusCode: result.status,
      contentType: result.contentType,
      ...(pageError && { pageError }),
    });
  } catch (error) {
    res.status(500).json({ error: 'An error occurred while fetching the page.' });
  } finally {
    if (page) await page.close();
    if (context) await context.close();
    pageSemaphore.release();
  }
});

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server running on port ${port}`);
  });
});
