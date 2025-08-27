import { crawl, batchScrape, idmux, Identity } from "./lib";
import Express from "express";
import bodyParser from "body-parser";
import type { WebhookEventType } from "src/types";
import type { Document } from "src/controllers/v1/types";

const WEBHOOK_PORT_CRAWL = 3008;
const WEBHOOK_PORT_BATCH_SCRAPE = 3009;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "webhook",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describe("Webhook tests", () => {
    it.concurrent("webhook works properly for crawl", async () => {
        const app = Express();
        app.use(bodyParser.json());

        const calls: {
            type: WebhookEventType,
            id: string,
            data: any;
        }[] = [];

        app.post("/webhook", (req, res) => {
            calls.push({
                type: req.body.type,
                id: req.body.id,
                data: req.body.data,
            });
            res.json({ ok: true })
        });

        const server = app.listen(WEBHOOK_PORT_CRAWL);

        const res = await crawl({
            url: "https://firecrawl.dev",
            limit: 10,
            webhook: {
                url: `http://localhost:${WEBHOOK_PORT_CRAWL}/webhook`,
            },
        }, identity);

        // wait to settle the webhook calls
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        server.close();

        let hasStarted = false;
        let hasCompleted = false;

        for (const call of calls) {
            expect(call.type).toMatch(/^crawl\./);

            if (call.type === "crawl.started") {
                hasStarted = true;
            } else if (call.type === "crawl.page") {
                const page = call.data[0] as Document;
                expect(res.data.find(x => page.metadata.scrapeId !== undefined && page.metadata.scrapeId === x.metadata.scrapeId)).toBeDefined();
            } else if (call.type === "crawl.completed") {
                hasCompleted = true;
            }
        }

        expect(hasStarted).toBe(true);
        expect(hasCompleted).toBe(true);

        expect(res.data.length).toBe(calls.filter(x => x.type === "crawl.page").length);
    }, 600000);

    it.concurrent("webhook works properly for batch scrape", async () => {
        const app = Express();
        app.use(bodyParser.json());

        const calls: {
            type: WebhookEventType,
            id: string,
            data: any;
        }[] = [];

        app.post("/webhook", (req, res) => {
            calls.push({
                type: req.body.type,
                id: req.body.id,
                data: req.body.data,
            });
            res.json({ ok: true })
        });

        const server = app.listen(WEBHOOK_PORT_BATCH_SCRAPE);

        const res = await batchScrape({
            urls: [
                "https://firecrawl.dev",
                "https://firecrawl.dev/blog",
            ],
            webhook: {
                url: `http://localhost:${WEBHOOK_PORT_BATCH_SCRAPE}/webhook`,
            },
        }, identity);

        // wait to settle the webhook calls
        await new Promise(resolve => setTimeout(resolve, 1000));

        server.close();

        let hasStarted = false;
        let hasCompleted = false;

        for (const call of calls) {
            expect(call.type).toMatch(/^batch_scrape\./);

            if (call.type === "batch_scrape.started") {
                hasStarted = true;
            } else if (call.type === "batch_scrape.page") {
                const page = call.data[0] as Document;
                expect(res.data.find(x => page.metadata.scrapeId !== undefined && page.metadata.scrapeId === x.metadata.scrapeId)).toBeDefined();
            } else if (call.type === "batch_scrape.completed") {
                hasCompleted = true;
            }
        }

        expect(hasStarted).toBe(true);
        expect(hasCompleted).toBe(true);

        expect(res.data.length).toBe(calls.filter(x => x.type === "batch_scrape.page").length);
    }, 600000);
});