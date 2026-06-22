# Firecrawl Node SDK

The Firecrawl Node SDK is a library that lets you easily search, scrape, and interact with the web for AI agents — returning clean Markdown or structured data your agents can ship with. It provides a simple and intuitive interface for the Firecrawl API.

## Installation

To install the Firecrawl Node SDK, you can use npm:

```bash
npm install firecrawl
```

## Usage

1. Get an API key from [firecrawl.dev](https://firecrawl.dev)
2. Set the API key as an environment variable named `FIRECRAWL_API_KEY` or pass it as a parameter to the `FirecrawlApp` class.

Here's an example of how to use the SDK with error handling:

```js
import { Firecrawl } from 'firecrawl';

const app = new Firecrawl({ apiKey: 'fc-YOUR_API_KEY' });

// Scrape a website
const scrapeResponse = await app.scrape('https://firecrawl.dev', {
  formats: ['markdown', 'html'],
});
console.log(scrapeResponse);

// Crawl a website (waiter)
const crawlResponse = await app.crawl('https://firecrawl.dev', {
  limit: 100,
  scrapeOptions: { formats: ['markdown', 'html'] },
  pollInterval: 2,
});
console.log(crawlResponse);
```

### Scraping a URL

To scrape a single URL with error handling, use the `scrape` method. It takes the URL as a parameter and returns the scraped data.

```js
const url = 'https://example.com';
const scrapedData = await app.scrape(url);
```

### Video extraction

Use the `video` format on supported video URLs, including YouTube and TikTok. The returned `video` field is a signed URL to the extracted video file.

```js
const doc = await app.scrape('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
  formats: ['video'],
});

console.log(doc.video);
```

### Product extraction

Use the `product` format to deterministically pull a product (title, price, availability, variants) from product pages — the deterministic counterpart to the LLM-based `json` format.

```js
const doc = await app.scrape('https://example.com/product/123', {
  formats: ['product'],
});

console.log(doc.product);
```

### Menu extraction

Use the `menu` format to deterministically pull a merchant's menu (sections, items, prices, availability) from menu pages — the deterministic counterpart to the LLM-based `json` format.

```js
const doc = await app.scrape('https://example.com/restaurant/menu', {
  formats: ['menu'],
});

console.log(doc.menu);
```

### Parsing uploaded files

Use `parse` to upload a file (`html`, `pdf`, `docx`, etc.) as multipart form data and process it through the same parsing pipeline.
Parse does not support browser-only formats/options like `changeTracking`, `screenshot`, `branding`, `audio`, `video`, `actions`, `waitFor`, `location`, or `mobile`.

```js
const parsed = await app.parse(
  {
    data: '<html><body><h1>Hello parse</h1></body></html>',
    filename: 'upload.html',
    contentType: 'text/html',
  },
  {
    formats: ['markdown'],
  }
);

console.log(parsed.markdown);
```

### Crawling a Website

To crawl a website with error handling, use the `crawl` method. It takes the starting URL and optional parameters, including limits and per‑page `scrapeOptions`.

```js
const crawlResponse = await app.crawl('https://firecrawl.dev', {
  limit: 100,
  scrapeOptions: { formats: ['markdown', 'html'] },
});
```


### Asynchronous Crawl

To start an asynchronous crawl, use `startCrawl`. It returns a job ID you can poll with `getCrawlStatus`.

```js
const start = await app.startCrawl('https://mendable.ai', {
  excludePaths: ['blog/*'],
  limit: 5,
});
```

### Checking Crawl Status

To check the status of a crawl job with error handling, use the `getCrawlStatus` method. It takes the job ID as a parameter and returns the current status.

```js
const status = await app.getCrawlStatus(id);
```

### Extracting structured data from URLs

Use `extract` with a prompt and schema. Zod schemas are supported directly.

```js
import { Firecrawl } from 'firecrawl';
import { z } from 'zod';

const app = new Firecrawl({ apiKey: 'fc-YOUR_API_KEY' });

const schema = z.object({
  title: z.string(),
});

const result = await app.extract({
  urls: ['https://firecrawl.dev'],
  prompt: 'Extract the page title',
  schema,
  showSources: true,
});

console.log(result.data);
```

### Map a Website

Use `map` to generate a list of URLs from a website. Options let you customize the mapping process, including whether to utilize the sitemap or include subdomains.

```js
const mapResult = await app.map('https://example.com');
console.log(mapResult);
```

### Scrape-bound interactive browsing (v2)

Use a scrape job ID to keep interacting with the replayed browser context:

```js
const doc = await app.scrape('https://example.com', {
  actions: [{ type: 'click', selector: 'a[href="/pricing"]' }],
});

const scrapeJobId = doc?.metadata?.scrapeId;
if (!scrapeJobId) throw new Error('Missing scrapeId');

const run = await app.interact(scrapeJobId, {
  code: 'console.log(await page.url())',
  language: 'node',
  timeout: 60,
});
console.log(run.stdout);

await app.stopInteraction(scrapeJobId);
```

### Crawl a website with real‑time updates

To receive real‑time updates, start a crawl and attach a watcher.

```js
const start = await app.startCrawl('https://mendable.ai', { excludePaths: ['blog/*'], limit: 5 });
const watch = app.watcher(start.id, { kind: 'crawl', pollInterval: 2 });

watch.on('document', (doc) => {
  console.log('DOC', doc);
});

watch.on('error', (err) => {
  console.error('ERR', err);
});

watch.on('done', (state) => {
  console.log('DONE', state.status);
});

await watch.start();
```

### Batch scraping multiple URLs

To batch scrape multiple URLs with error handling, use the `batchScrape` method.

```js
const batchScrapeResponse = await app.batchScrape(['https://firecrawl.dev', 'https://mendable.ai'], {
  formats: ['markdown', 'html'],
});
```


#### Asynchronous batch scrape

To start an asynchronous batch scrape, use `startBatchScrape` and poll with `getBatchScrapeStatus`.

```js
const asyncBatchScrapeResult = await app.startBatchScrape(['https://firecrawl.dev', 'https://mendable.ai'], {
  formats: ['markdown', 'html'],
});
```

#### Batch scrape with real‑time updates

To use batch scrape with real‑time updates, start the job and watch it using the watcher.

```js
const start = await app.startBatchScrape(['https://firecrawl.dev', 'https://mendable.ai'], { formats: ['markdown', 'html'] });
const watch = app.watcher(start.id, { kind: 'batch', pollInterval: 2 });

watch.on('document', (doc) => {
  console.log('DOC', doc);
});

watch.on('error', (err) => {
  console.error('ERR', err);
});

watch.on('done', (state) => {
  console.log('DONE', state.status);
});

await watch.start();
```

## v1 compatibility

The feature‑frozen v1 is still available under `app.v1` with the original method names.

```js
import { Firecrawl } from 'firecrawl';

const app = new Firecrawl({ apiKey: 'fc-YOUR_API_KEY' });

// v1 methods (feature‑frozen)
const scrapeV1 = await app.v1.scrapeUrl('https://firecrawl.dev', { formats: ['markdown', 'html'] });
const crawlV1 = await app.v1.crawlUrl('https://firecrawl.dev', { limit: 100 });
const mapV1 = await app.v1.mapUrl('https://firecrawl.dev');
```

## Error Handling

The SDK handles errors returned by the Firecrawl API and raises appropriate exceptions. If an error occurs during a request, an exception will be raised with a descriptive error message. The examples above demonstrate how to handle these errors using `try/catch` blocks.

## License

The Firecrawl Node SDK is licensed under the MIT License. This means you are free to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the SDK, subject to the following conditions:

- The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Please note that while this SDK is MIT licensed, it is part of a larger project which may be under different licensing terms. Always refer to the license information in the root directory of the main project for overall licensing details.
