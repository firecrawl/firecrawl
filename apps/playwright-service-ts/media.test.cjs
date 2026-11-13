const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { after, test, mock } = require('node:test');
const { chromium } = require('playwright');
const proxyChain = require('proxy-chain');

const handlers = new Map();
const browsers = [];
const proxies = [];
const express = () => ({
  use() {},
  get(path, handler) {
    handlers.set(`GET ${path}`, handler);
  },
  post(path, handler) {
    handlers.set(`POST ${path}`, handler);
  },
  listen(_port, ready) {
    ready();
  },
});
express.json = () => () => {};

mock.module('express', { defaultExport: express });
mock.module('dotenv', { defaultExport: { config() {} } });
mock.module('playwright', {
  namedExports: {
    chromium: {
      async launch(options) {
        const browser = await chromium.launch({
          ...options,
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        });
        browsers.push(browser);
        return browser;
      },
    },
  },
});
mock.module('proxy-chain', {
  namedExports: {
    ...proxyChain,
    Server: class extends proxyChain.Server {
      constructor(options) {
        super(options);
        proxies.push(this);
      }
    },
  },
});

after(async () => {
  await Promise.all(browsers.map((browser) => browser.close()));
  await Promise.all(proxies.map((proxy) => proxy.close(true)));
  mock.restoreAll();
});

for (const blockMedia of [true, false]) {
  test(
    `BLOCK_MEDIA=${blockMedia} preserves document, script, CSS, XHR and font requests`,
    { timeout: 20000 },
    async (t) => {
      const hits = [];
      const server = http.createServer((req, res) => {
        hits.push(req.url);
        if (req.url === '/') {
          res.setHeader('Content-Type', 'text/html');
          res.end(`<html><head><link rel="stylesheet" href="/style.css"></head><body>
          <span>Font request fixture</span><img src="/image.png"><script src="/script.js"></script>
          <script>Promise.all([fetch('/data'), document.fonts.ready]).then(() => document.body.dataset.ready = 'yes');</script>
        </body></html>`);
        } else if (req.url === '/script.js') {
          res.setHeader('Content-Type', 'application/javascript');
          res.end('document.body.dataset.script = "yes";');
        } else if (req.url === '/style.css') {
          res.setHeader('Content-Type', 'text/css');
          res.end(
            '@font-face { font-family: fixture; src: url(/font.woff2); } body { color: red; font-family: fixture; }',
          );
        } else {
          res.end('fixture');
        }
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      t.after(() => new Promise((resolve) => server.close(resolve)));

      process.env.BLOCK_MEDIA = String(blockMedia);
      process.env.ALLOW_LOCAL_WEBHOOKS = 'true';
      delete process.env.PROXY_SERVER;
      const beforeLaunch = browsers.length;
      delete require.cache[require.resolve('./api.ts')];
      require('./api.ts');
      // Startup launches Chromium asynchronously; wait for the service to finish.
      while (browsers.length === beforeLaunch) {
        t.signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setImmediate(resolve));

      const response = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          this.body = body;
          return this;
        },
      };
      await handlers.get('POST /scrape')(
        {
          body: {
            url: `http://127.0.0.1:${server.address().port}/`,
            check_selector: 'body[data-ready="yes"][data-script="yes"]',
          },
        },
        response,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.body.pageStatusCode, 200);
      for (const resource of [
        '/',
        '/script.js',
        '/style.css',
        '/data',
        '/font.woff2',
      ]) {
        assert.ok(
          hits.includes(resource),
          `missing allowed request: ${resource}`,
        );
      }
      assert.equal(
        hits.includes('/image.png'),
        !blockMedia,
        'media must honor BLOCK_MEDIA',
      );
    },
  );
}
