import { batchScrape, crawl, creditUsage, extract, idmux, map, scrape, search, tokenUsage } from "./lib";

const sleep = (ms: number) => new Promise(x => setTimeout(() => x(true), ms));
const sleepForBatchBilling = () => sleep(40000);

describe("Billing tests", () => {
    if (process.env.TEST_SUITE_SELF_HOSTED) {
        it("dummy", () => {
            expect(true).toBe(true);
        });
    } else {
        it.concurrent("bills scrape correctly", async () => {
            const identity = await idmux({
                name: "billing/bills scrape correctly",
                credits: 100,
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;
            
            // Run all scrape operations in parallel with Promise.all
            const [scrape1, scrape2, scrape3] = await Promise.all([
                // scrape 1: regular fc.dev scrape (1 credit)
                scrape({
                    url: "https://firecrawl.dev"
                }, identity),
                
                // scrape 1.1: regular fc.dev scrape (1 credit)
                scrape({
                    url: "https://firecrawl.dev"
                }, identity),
                
                // scrape 2: fc.dev with json (5 credits)
                scrape({
                    url: "https://firecrawl.dev",
                    formats: ["json"],
                    jsonOptions: {
                        schema: {
                            type: "object",
                            properties: {
                                is_open_source: { type: "boolean" },
                            },
                            required: ["is_open_source"],
                        },
                    },
                }, identity)
            ]);

            expect(scrape1.metadata.creditsUsed).toBe(1);
            expect(scrape2.metadata.creditsUsed).toBe(1);
            expect(scrape3.metadata.creditsUsed).toBe(5);
            
            // sum: 7 credits

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            expect(rc1 - rc2).toBe(7);
        }, 120000);

        it.concurrent("bills batch scrape correctly", async () => {
            const identity = await idmux({
                name: "billing/bills batch scrape correctly",
                credits: 100,
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;
            
            // Run both scrape operations in parallel with Promise.all
            const [scrape1, scrape2] = await Promise.all([
                // scrape 1: regular batch scrape with failing domain (2 credits)
                batchScrape({
                    urls: [
                        "https://firecrawl.dev",
                        "https://mendable.ai",
                        "https://thisdomaindoesnotexistandwillfail.fcr",
                    ],
                }, identity),
                
                // scrape 2: batch scrape with json (10 credits)
                batchScrape({
                    urls: [
                        "https://firecrawl.dev",
                        "https://mendable.ai",
                        "https://thisdomaindoesnotexistandwillfail.fcr",
                    ],
                    formats: ["json"],
                    jsonOptions: {
                        schema: {
                            type: "object",
                            properties: {
                                four_word_summary: { type: "string" },
                            },
                            required: ["four_word_summary"],
                        },
                    },
                }, identity)
            ]);

            expect(scrape1.data[0].metadata.creditsUsed).toBe(1);
            expect(scrape1.data[1].metadata.creditsUsed).toBe(1);

            expect(scrape2.data[0].metadata.creditsUsed).toBe(5);
            expect(scrape2.data[1].metadata.creditsUsed).toBe(5);
            
            // sum: 12 credits

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            expect(rc1 - rc2).toBe(12);
        }, 600000);

        it.concurrent("bills crawl correctly", async () => {
            const identity = await idmux({
                name: "billing/bills crawl correctly",
                credits: 200,
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;
            
            // Run both crawl operations in parallel with Promise.all
            const [crawl1, crawl2] = await Promise.all([
                // crawl 1: regular fc.dev crawl (x credits)
                crawl({
                    url: "https://firecrawl.dev",
                    limit: 10,
                }, identity),
                
                // crawl 2: fc.dev crawl with json (5y credits)
                crawl({
                    url: "https://firecrawl.dev",
                    scrapeOptions: {
                        formats: ["json"],
                        jsonOptions: {
                            schema: {
                                type: "object",
                                properties: {
                                    four_word_summary: { type: "string" },
                                },
                                required: ["four_word_summary"],
                            },
                        },
                    },
                    limit: 10,
                }, identity)
            ]);
            
            expect(crawl1.success).toBe(true);
            expect(crawl2.success).toBe(true);
            
            // sum: x+5y credits

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            if (crawl1.success && crawl2.success) {
                expect(rc1 - rc2).toBe(crawl1.completed + crawl2.completed * 5);
            }
        }, 600000);

        it.concurrent("bills map correctly", async () => {
            const identity = await idmux({
                name: "billing/bills map correctly",
                credits: 100,
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;
            await map({ url: "https://firecrawl.dev" }, identity);
            await sleepForBatchBilling();
            const rc2 = (await creditUsage(identity)).remaining_credits;
            expect(rc1 - rc2).toBe(1);
        }, 60000);

        it.concurrent("bills search correctly", async () => {
            const identity = await idmux({
                name: "billing/bills search correctly",
                credits: 100,
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;

            const results = await search({
                query: "firecrawl"
            }, identity);

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            expect(rc1 - rc2).toBe(results.length);
        }, 60000);

        it.concurrent("bills search with scrape correctly", async () => {
            const identity = await idmux({
                name: "billing/bills search with scrape correctly",
                credits: 100,
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;

            const results = await search({
                query: "firecrawl",
                scrapeOptions: {
                    formats: ["markdown"],
                },
            }, identity);

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            expect(rc1 - rc2).toBe(results.length);
        }, 600000);

        it.concurrent("bills search with PDF scrape correctly", async () => {
            const identity = await idmux({
                name: "billing/bills search with PDF scrape correctly",
                credits: 100,
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;

            const results = await search({
                query: "firecrawl filetype:pdf",
                scrapeOptions: {
                    formats: ["markdown"],
                    parsePDF: true,
                },
            }, identity);

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            const shouldUse = results.reduce((sum, doc) => sum + (doc.metadata?.numPages || 1), 0);

            expect(rc1 - rc2).toBe(shouldUse);
        }, 600000);

        it.concurrent("bills search with parsePDF=false correctly", async () => {
            const identity = await idmux({
                name: "billing/bills search with parsePDF=false correctly",
                credits: 100,
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;

            const results = await search({
                query: "firecrawl filetype:pdf",
                scrapeOptions: {
                    formats: ["markdown"],
                    parsePDF: false,
                },
            }, identity);

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            const expectedCredits = results.length;

            expect(rc1 - rc2).toBe(expectedCredits);
        }, 600000);

        it.concurrent("bills extract correctly", async () => {
            const identity = await idmux({
                name: "billing/bills extract correctly",
                tokens: 1000,
            });

            const rc1 = (await tokenUsage(identity)).remaining_tokens;
            
            const extractResult = await extract({
                urls: ["https://firecrawl.dev"],
                schema: {
                    "type": "object",
                    "properties": {
                        "is_open_source": {
                            "type": "boolean"
                        }
                    },
                    "required": [
                        "is_open_source"
                    ]
                },
                origin: "api-sdk",
            }, identity);

            expect(extractResult.tokensUsed).toBe(305);

            await sleepForBatchBilling();
            
            const rc2 = (await tokenUsage(identity)).remaining_tokens;

            expect(rc1 - rc2).toBe(305);
        }, 300000);

        it.concurrent("bills ZDR scrape correctly", async () => {
            const identity = await idmux({
                name: "billing/bills ZDR scrape correctly",
                credits: 100,
                flags: {
                    allowZDR: true,                    
                }
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;
            
            // Run all scrape operations in parallel with Promise.all
            const [scrape1, scrape2, scrape3] = await Promise.all([
                // scrape 1: regular fc.dev scrape (1 credit)
                scrape({
                    url: "https://firecrawl.dev",
                    zeroDataRetention: true,
                }, identity),
                
                // scrape 1.1: regular fc.dev scrape (1 credit)
                scrape({
                    url: "https://firecrawl.dev",
                    zeroDataRetention: true,
                }, identity),
                
                // scrape 2: fc.dev with json (5 credits)
                scrape({
                    url: "https://firecrawl.dev",
                    formats: ["json"],
                    jsonOptions: {
                        schema: {
                            type: "object",
                            properties: {
                                is_open_source: { type: "boolean" },
                            },
                            required: ["is_open_source"],
                        },
                    },
                    zeroDataRetention: true,
                }, identity)
            ]);

            expect(scrape1.metadata.creditsUsed).toBe(2);
            expect(scrape2.metadata.creditsUsed).toBe(2);
            expect(scrape3.metadata.creditsUsed).toBe(6);
            
            // sum: 10 credits

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            expect(rc1 - rc2).toBe(10);
        }, 120000);

        it.concurrent("bills ZDR batch scrape correctly", async () => {
            const identity = await idmux({
                name: "billing/bills ZDR batch scrape correctly",
                credits: 100,
                flags: {
                    allowZDR: true,
                }
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;
            
            // Run both scrape operations in parallel with Promise.all
            const [scrape1, scrape2] = await Promise.all([
                // scrape 1: regular batch scrape with failing domain (2 credits)
                batchScrape({
                    urls: [
                        "https://firecrawl.dev",
                        "https://mendable.ai",
                        "https://thisdomaindoesnotexistandwillfail.fcr",
                    ],
                    zeroDataRetention: true,
                }, identity),
                
                // scrape 2: batch scrape with json (10 credits)
                batchScrape({
                    urls: [
                        "https://firecrawl.dev",
                        "https://mendable.ai",
                        "https://thisdomaindoesnotexistandwillfail.fcr",
                    ],
                    formats: ["json"],
                    jsonOptions: {
                        schema: {
                            type: "object",
                            properties: {
                                four_word_summary: { type: "string" },
                            },
                            required: ["four_word_summary"],
                        },
                    },
                    zeroDataRetention: true,
                }, identity)
            ]);

            expect(scrape1.data[0].metadata.creditsUsed).toBe(2);
            expect(scrape1.data[1].metadata.creditsUsed).toBe(2);

            expect(scrape2.data[0].metadata.creditsUsed).toBe(6);
            expect(scrape2.data[1].metadata.creditsUsed).toBe(6);
            
            // sum: 16 credits

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            expect(rc1 - rc2).toBe(16);
        }, 600000);

        it.concurrent("bills ZDR crawl correctly", async () => {
            const identity = await idmux({
                name: "billing/bills ZDR crawl correctly",
                credits: 200,
                flags: {
                    allowZDR: true,
                }
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;
            
            // Run both crawl operations in parallel with Promise.all
            const [crawl1, crawl2] = await Promise.all([
                // crawl 1: regular fc.dev crawl (x credits)
                crawl({
                    url: "https://firecrawl.dev",
                    limit: 10,
                    zeroDataRetention: true,
                }, identity),
                
                // crawl 2: fc.dev crawl with json (5y credits)
                crawl({
                    url: "https://firecrawl.dev",
                    scrapeOptions: {
                        formats: ["json"],
                        jsonOptions: {
                            schema: {
                                type: "object",
                                properties: {
                                    four_word_summary: { type: "string" },
                                },
                                required: ["four_word_summary"],
                            },
                        },
                    },
                    limit: 10,
                    zeroDataRetention: true,
                }, identity)
            ]);
            
            expect(crawl1.success).toBe(true);
            expect(crawl2.success).toBe(true);
            
            // sum: 2x+6y credits

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            if (crawl1.success && crawl2.success) {
                expect(rc1 - rc2).toBe(crawl1.completed * 2 + crawl2.completed * 6);
            }
        }, 600000);

        it.concurrent("bills custom-cost ZDR scrape correctly", async () => {
            const identity = await idmux({
                name: "billing/bills ZDR scrape correctly",
                credits: 100,
                flags: {
                    allowZDR: true,
                    zdrCost: 0,                 
                }
            });

            const rc1 = (await creditUsage(identity)).remaining_credits;
            
            // Run all scrape operations in parallel with Promise.all
            const [scrape1, scrape2, scrape3] = await Promise.all([
                // scrape 1: regular fc.dev scrape (1 credit)
                scrape({
                    url: "https://firecrawl.dev",
                    zeroDataRetention: true,
                }, identity),
                
                // scrape 1.1: regular fc.dev scrape (1 credit)
                scrape({
                    url: "https://firecrawl.dev",
                    zeroDataRetention: true,
                }, identity),
                
                // scrape 2: fc.dev with json (5 credits)
                scrape({
                    url: "https://firecrawl.dev",
                    formats: ["json"],
                    jsonOptions: {
                        schema: {
                            type: "object",
                            properties: {
                                is_open_source: { type: "boolean" },
                            },
                            required: ["is_open_source"],
                        },
                    },
                    zeroDataRetention: true,
                }, identity)
            ]);

            expect(scrape1.metadata.creditsUsed).toBe(1);
            expect(scrape2.metadata.creditsUsed).toBe(1);
            expect(scrape3.metadata.creditsUsed).toBe(5);
            
            // sum: 7 credits

            await sleepForBatchBilling();

            const rc2 = (await creditUsage(identity)).remaining_credits;

            expect(rc1 - rc2).toBe(7);
        }, 120000);
    }
});
