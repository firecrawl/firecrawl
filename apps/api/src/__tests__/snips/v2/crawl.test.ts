import { asyncCrawl, asyncCrawlWaitForFinish, crawl, crawlOngoing, crawlStart, Identity, idmux, scrapeTimeout } from "./lib";
import { describe, it, expect } from "@jest/globals";
import { filterLinks } from "../../../lib/crawler";

let identity: Identity;

beforeAll(async () => {
    identity = await idmux({
        name: "crawl",
        concurrency: 100,
        credits: 1000000,
    });
}, 10000);

describe("Crawl tests", () => {
    it.concurrent("works", async () => {
        const results = await crawl({
            url: "https://firecrawl.dev",
            limit: 10,
        }, identity);

        expect(results.completed).toBe(10);
    }, 10 * scrapeTimeout);

    it.concurrent("works with sitemap: skip", async () => {
        const results = await crawl({
            url: "https://firecrawl.dev",
            limit: 10,
            sitemap: "skip",
        }, identity);

        expect(results.completed).toBe(10);
    }, 10 * scrapeTimeout);

    it.concurrent("filters URLs properly", async () => {
        const res = await crawl({
            url: "https://firecrawl.dev/pricing",
            includePaths: ["^/pricing$"],
            limit: 10,
        }, identity);

        expect(res.success).toBe(true);
        if (res.success) {
            expect(res.completed).toBeGreaterThan(0);
            for (const page of res.data) {
                const url = new URL(page.metadata.url ?? page.metadata.sourceURL!);
                expect(url.pathname).toMatch(/^\/pricing$/);
            }
        }
    }, 10 * scrapeTimeout);

    it.concurrent("filters URLs properly when using regexOnFullURL", async () => {
        const res = await crawl({
            url: "https://firecrawl.dev/pricing",
            includePaths: ["^https://(www\\.)?firecrawl\\.dev/pricing$"],
            regexOnFullURL: true,
            limit: 10,
        }, identity);

        expect(res.success).toBe(true);
        if (res.success) {
            expect(res.completed).toBe(1);
            expect(res.data[0].metadata.sourceURL).toBe("https://firecrawl.dev/pricing");
        }
    }, 10 * scrapeTimeout);

    it.concurrent("delay parameter works", async () => {
        await crawl({
            url: "https://firecrawl.dev",
            limit: 3,
            delay: 5,
        }, identity);
    }, 3 * scrapeTimeout + 3 * 5000);

    it.concurrent("ongoing crawls endpoint works", async () => {
        const beforeCrawl = new Date();

        const res = await asyncCrawl({
            url: "https://firecrawl.dev",
            limit: 3,
        }, identity);

        const ongoing = await crawlOngoing(identity);
        const afterCrawl = new Date();

        const crawlItem = ongoing.crawls.find(x => x.id === res.id);
        expect(crawlItem).toBeDefined();

        if (crawlItem) {
            expect(crawlItem.created_at).toBeDefined();
            expect(typeof crawlItem.created_at).toBe("string");

            const createdAtDate = new Date(crawlItem.created_at);
            expect(createdAtDate).toBeInstanceOf(Date);
            expect(createdAtDate.getTime()).not.toBeNaN();

            expect(crawlItem.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

            expect(createdAtDate.getTime()).toBeGreaterThanOrEqual(beforeCrawl.getTime() - 1000);
            expect(createdAtDate.getTime()).toBeLessThanOrEqual(afterCrawl.getTime() + 1000);
        }

        await asyncCrawlWaitForFinish(res.id, identity);

        const ongoing2 = await crawlOngoing(identity);

        expect(ongoing2.crawls.find(x => x.id === res.id)).toBeUndefined();
    }, 3 * scrapeTimeout);

    // TEMP: Flaky
    // it.concurrent("discovers URLs properly when origin is not included", async () => {
    //     const res = await crawl({
    //         url: "https://firecrawl.dev",
    //         includePaths: ["^/blog"],
    //         ignoreSitemap: true,
    //         limit: 10,
    //     });

    //     expect(res.success).toBe(true);
    //     if (res.success) {
    //         expect(res.data.length).toBeGreaterThan(1);
    //         for (const page of res.data) {
    //             expect(page.metadata.url ?? page.metadata.sourceURL).toMatch(/^https:\/\/(www\.)?firecrawl\.dev\/blog/);
    //         }
    //     }
    // }, 300000);

    // TEMP: Flaky
    // it.concurrent("discovers URLs properly when maxDiscoveryDepth is provided", async () => {
    //     const res = await crawl({
    //         url: "https://firecrawl.dev",
    //         ignoreSitemap: true,
    //         maxDiscoveryDepth: 1,
    //         limit: 10,
    //     });
    //     expect(res.success).toBe(true);
    //     if (res.success) {
    //         expect(res.data.length).toBeGreaterThan(1);
    //         for (const page of res.data) {
    //             expect(page.metadata.url ?? page.metadata.sourceURL).not.toMatch(/^https:\/\/(www\.)?firecrawl\.dev\/blog\/.+$/);
    //         }
    //     }
    // }, 300000);

    it.concurrent("crawlEntireDomain parameter works", async () => {
        const res = await crawl({
            url: "https://firecrawl.dev",
            crawlEntireDomain: true,
            limit: 5,
        }, identity);

        expect(res.success).toBe(true);
        if (res.success) {
            expect(res.completed).toBeGreaterThan(0);
        }
    }, 5 * scrapeTimeout);

    it.concurrent("allowSubdomains parameter works", async () => {
        const res = await crawl({
            url: "https://firecrawl.dev",
            allowSubdomains: true,
            limit: 5,
        }, identity);

        expect(res.success).toBe(true);
        if (res.success) {
            expect(res.completed).toBeGreaterThan(0);
        }
    }, 5 * scrapeTimeout);

    it.concurrent("allowSubdomains blocks subdomains when false", async () => {
        const res = await crawl({
            url: "https://firecrawl.dev",
            allowSubdomains: false,
            limit: 5,
        }, identity);

        expect(res.success).toBe(true);
        if (res.success) {
            for (const page of res.data) {
                const url = new URL(page.metadata.url ?? page.metadata.sourceURL!);
                expect(url.hostname.endsWith("firecrawl.dev")).toBe(true);
            }
        }
    }, 5 * scrapeTimeout);

    it.concurrent("allowSubdomains correctly allows same registrable domain using PSL", async () => {
        const res = await crawl({
            url: "https://firecrawl.dev",
            allowSubdomains: true,
            allowExternalLinks: false,
            limit: 3,
        }, identity);

        expect(res.success).toBe(true);
        if (res.success) {
            expect(res.data.length).toBeGreaterThan(0);
            for (const page of res.data) {
                const url = new URL(page.metadata.url ?? page.metadata.sourceURL!);
                const hostname = url.hostname;

                expect(
                    hostname === "firecrawl.dev" ||
                    hostname.endsWith(".firecrawl.dev")
                ).toBe(true);
            }
        }
    }, 5 * scrapeTimeout);

    if (!process.env.TEST_SUITE_SELF_HOSTED || process.env.OPENAI_API_KEY || process.env.OLLAMA_BASE_URL) {
        describe('Crawl API with Prompt', () => {
            it.concurrent('should accept prompt parameter in schema', async () => {
                const res = await crawlStart({
                    url: "https://firecrawl.dev",
                    prompt: "Crawl only blog posts",
                    limit: 1,
                }, identity);

                expect(res.statusCode).toBe(200);
                expect(res.body.success).toBe(true);
                expect(res.body.id).toBeDefined();
                expect(typeof res.body.id).toBe("string");
            }, scrapeTimeout);

            it.concurrent('should prioritize explicit options over prompt-generated options', async () => {
                const res = await crawl({
                    url: "https://firecrawl.dev",
                    prompt: "Crawl everything including external links and subdomains",
                    // Explicit options that should override the prompt
                    allowExternalLinks: false,
                    allowSubdomains: false,
                    includePaths: ["^/pricing"],
                    limit: 2,
                }, identity);

                expect(res.success).toBe(true);
                if (res.success) {
                    // Verify that explicit options were respected
                    for (const page of res.data) {
                        const url = new URL(page.metadata.url ?? page.metadata.sourceURL!);
                        // Should only include pages matching the explicit includePaths
                        expect(url.pathname).toMatch(/^\/pricing/);
                        // Should not include external links despite prompt
                        expect(url.hostname).toMatch(/firecrawl\.dev$/);
                    }
                }
            }, 2 * scrapeTimeout);

            it.concurrent('should handle invalid prompt gracefully', async () => {
                // Test with various invalid prompts
                const invalidPrompts = [
                    "",  // Empty prompt
                    "a".repeat(10000),  // Screaming
                    "!!!@@@###$$$%%%",  // Gibberish
                    "Generate me a million dollars",  // Nonsensical crawl instruction
                ];

                for (const invalidPrompt of invalidPrompts) {  // Test first one to avoid long test times
                    const res = await crawl({
                        url: "https://firecrawl.dev",
                        prompt: invalidPrompt,
                        limit: 1,
                    }, identity, false);

                    // Should still complete successfully, either ignoring the prompt or using defaults
                    expect(res.success).toBe(true);
                    if (res.success) {
                        expect(res.data).toBeDefined();
                        expect(Array.isArray(res.data)).toBe(true);
                    }
                }
            }, 8 * scrapeTimeout);
        });
    }
});

describe("Robots.txt FFI Integration tests", () => {
    it.concurrent("handles normal robots.txt parsing via FFI", async () => {
        const result = await filterLinks({
            links: ['https://example.com/allowed', 'https://example.com/disallowed'],
            limit: 10,
            max_depth: 10,
            base_url: 'https://example.com',
            initial_url: 'https://example.com',
            regex_on_full_url: false,
            excludes: [],
            includes: [],
            allow_backward_crawling: true,
            ignore_robots_txt: false,
            robots_txt: 'User-agent: *\nDisallow: /disallowed'
        });

        expect(result.links).toHaveLength(1);
        expect(result.links[0]).toBe('https://example.com/allowed');
        expect(result.denial_reasons.has('https://example.com/disallowed')).toBe(true);
        expect(result.denial_reasons.get('https://example.com/disallowed')).toBe('ROBOTS_TXT');
    }, 10000);

    it.concurrent("handles malformed robots.txt without crashing via FFI", async () => {
        const result = await filterLinks({
            links: ['https://example.com/test'],
            limit: 10,
            max_depth: 10,
            base_url: 'https://example.com',
            initial_url: 'https://example.com',
            regex_on_full_url: false,
            excludes: [],
            includes: [],
            allow_backward_crawling: true,
            ignore_robots_txt: false,
            robots_txt: 'Invalid robots.txt content with \x00 null bytes and malformed syntax'
        });

        expect(result.links).toHaveLength(1);
        expect(result.links[0]).toBe('https://example.com/test');
    }, 10000);

    it.concurrent("handles non-UTF8 robots.txt content without crashing via FFI", async () => {
        const nonUtf8Content = String.fromCharCode(0xFF, 0xFE) + 'User-agent: *\nDisallow: /blocked';
        const result = await filterLinks({
            links: ['https://example.com/allowed'],
            limit: 10,
            max_depth: 10,
            base_url: 'https://example.com',
            initial_url: 'https://example.com',
            regex_on_full_url: false,
            excludes: [],
            includes: [],
            allow_backward_crawling: true,
            ignore_robots_txt: false,
            robots_txt: nonUtf8Content
        });

        expect(result.links).toHaveLength(1);
        expect(result.links[0]).toBe('https://example.com/allowed');
    }, 10000);

    it.concurrent("handles char boundary issues without crashing via FFI", async () => {
        const problematicContent = 'User-agent: *\nDisallow: /\u{a0}test';
        const result = await filterLinks({
            links: ['https://example.com/safe'],
            limit: 10,
            max_depth: 10,
            base_url: 'https://example.com',
            initial_url: 'https://example.com',
            regex_on_full_url: false,
            excludes: [],
            includes: [],
            allow_backward_crawling: true,
            ignore_robots_txt: false,
            robots_txt: problematicContent
        });

        expect(result.links).toHaveLength(1);
        expect(result.links[0]).toBe('https://example.com/safe');
    }, 10000);
});
