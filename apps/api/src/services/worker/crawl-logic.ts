import { logger as _logger } from "../../lib/logger";
import { Job } from "bullmq";
import { addCrawlJobs, finishCrawl, getCrawlJobs, getDoneJobsOrderedLength, lockURLsIndividually, StoredCrawl, unPreFinishCrawl } from "../../lib/crawl-redis";
import { redisEvictConnection } from "../redis";
import { getCrawl } from "../../lib/crawl-redis";
import { finishCrawlPre } from "../../lib/crawl-redis";
import { getACUCTeam } from "../../controllers/auth";
import { crawlToCrawler } from "../../lib/crawl-redis";
import { supabase_service } from "../supabase";
import { v4 as uuidv4 } from "uuid";
import { addScrapeJobs } from "../queue-jobs";
import { getJobs } from "../../controllers/v1/crawl-status";
import { logJob } from "../logging/log_job";
import { callWebhook } from "../webhook";
import { hasFormatOfType } from "../../lib/format-utils";

export async function finishCrawlIfNeeded(job: Job & { id: string }, sc: StoredCrawl) {
    const logger = _logger.child({
        module: "queue-worker",
        method: "finishCrawlIfNeeded",
        jobId: job.id,
        scrapeId: job.id,
        crawlId: job.data.crawl_id,
        zeroDataRetention: sc.internalOptions.zeroDataRetention,
    });

    if (await finishCrawlPre(job.data.crawl_id, logger)) {
        logger.info("Crawl is pre-finished, checking if we need to add more jobs");
        if (
            job.data.crawlerOptions &&
            !(await redisEvictConnection.exists(
                "crawl:" + job.data.crawl_id + ":invisible_urls",
            ))
        ) {
            await redisEvictConnection.set(
                "crawl:" + job.data.crawl_id + ":invisible_urls",
                "done",
                "EX",
                60 * 60 * 24,
            );

            const sc = (await getCrawl(job.data.crawl_id))!;

            const visitedUrls = new Set(
                await redisEvictConnection.smembers(
                    "crawl:" + job.data.crawl_id + ":visited_unique",
                ),
            );

            logger.info("Visited URLs", {
                visitedUrls: visitedUrls.size,
            });

            let lastUrls: string[] = [];
            const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === "true";
            if (useDbAuthentication && hasFormatOfType(sc.scrapeOptions.formats, "changeTracking")) {
                lastUrls = (
                    (
                        await supabase_service.rpc("diff_get_last_crawl_urls", {
                            i_team_id: job.data.team_id,
                            i_url: sc.originUrl!,
                        })
                    ).data ?? []
                ).map((x) => x.url);
            }

            const lastUrlsSet = new Set(lastUrls);

            logger.info("Last URLs", {
                lastUrls: lastUrlsSet.size,
            });

            const crawler = crawlToCrawler(
                job.data.crawl_id,
                sc,
                (await getACUCTeam(job.data.team_id))?.flags ?? null,
                sc.originUrl!,
                job.data.crawlerOptions,
            );

            const univistedUrls = await crawler.filterLinks(
                Array.from(lastUrlsSet).filter((x) => !visitedUrls.has(x)),
                Infinity,
                sc.crawlerOptions.maxDepth ?? 10,
            );

            const addableJobCount =
                sc.crawlerOptions.limit === undefined
                    ? Infinity
                    : sc.crawlerOptions.limit -
                    (await getDoneJobsOrderedLength(job.data.crawl_id));

            if (univistedUrls.links.length !== 0 && addableJobCount > 0) {
                logger.info("Adding jobs", {
                    univistedUrls: univistedUrls.links.length,
                    addableJobCount,
                });

                const jobs = univistedUrls.links.slice(0, addableJobCount).map((url) => {
                    const uuid = uuidv4();
                    return {
                        name: uuid,
                        data: {
                            url,
                            mode: "single_urls" as const,
                            team_id: job.data.team_id,
                            crawlerOptions: {
                                ...job.data.crawlerOptions,
                                urlInvisibleInCurrentCrawl: true,
                            },
                            scrapeOptions: job.data.scrapeOptions,
                            internalOptions: sc.internalOptions,
                            origin: job.data.origin,
                            integration: job.data.integration,
                            crawl_id: job.data.crawl_id,
                            sitemapped: true,
                            webhook: job.data.webhook,
                            v1: job.data.v1,
                            zeroDataRetention: job.data.zeroDataRetention,
                        },
                        opts: {
                            jobId: uuid,
                            priority: 20,
                        },
                    };
                });

                const lockedIds = await lockURLsIndividually(
                    job.data.crawl_id,
                    sc,
                    jobs.map((x) => ({ id: x.opts.jobId, url: x.data.url })),
                );
                const lockedJobs = jobs.filter((x) =>
                    lockedIds.find((y) => y.id === x.opts.jobId),
                );
                await addCrawlJobs(
                    job.data.crawl_id,
                    lockedJobs.map((x) => x.opts.jobId),
                    logger,
                );
                await addScrapeJobs(lockedJobs);

                if (lockedJobs.length > 0) {
                    logger.info("Added jobs, not going for the full finish", {
                        lockedJobs: lockedJobs.length,
                    });

                    await unPreFinishCrawl(job.data.crawl_id);
                    return;
                } else {
                    logger.info("No jobs added (all discovered URLs were locked), finishing crawl");
                }
            }
        }

        logger.info("Finishing crawl");
        await finishCrawl(job.data.crawl_id, logger);

        if (!job.data.v1) {
            const jobIDs = await getCrawlJobs(job.data.crawl_id);

            const jobs = (await getJobs(jobIDs)).sort(
                (a, b) => a.timestamp - b.timestamp,
            );
            // const jobStatuses = await Promise.all(jobs.map((x) => x.getState()));
            const jobStatus = sc.cancelled // || jobStatuses.some((x) => x === "failed")
                ? "failed"
                : "completed";

            const fullDocs = jobs
                .map((x) =>
                    x.returnvalue
                        ? Array.isArray(x.returnvalue)
                            ? x.returnvalue[0]
                            : x.returnvalue
                        : null,
                )
                .filter((x) => x !== null);

            await logJob({
                job_id: job.data.crawl_id,
                success: jobStatus === "completed",
                message: sc.cancelled ? "Cancelled" : undefined,
                num_docs: fullDocs.length,
                docs: [],
                time_taken: (Date.now() - sc.createdAt) / 1000,
                team_id: job.data.team_id,
                mode: job.data.crawlerOptions !== null ? "crawl" : "batch_scrape",
                url: sc.originUrl!,
                scrapeOptions: sc.scrapeOptions,
                crawlerOptions: sc.crawlerOptions,
                origin: job.data.origin,
                integration: job.data.integration,
                zeroDataRetention: job.data.zeroDataRetention,
            }, false, job.data.internalOptions?.bypassBilling ?? false);

            const data = {
                success: jobStatus !== "failed",
                result: {
                    links: fullDocs.map((doc) => {
                        return {
                            content: doc,
                            source: doc?.metadata?.sourceURL ?? doc?.url ?? "",
                        };
                    }),
                },
                project_id: job.data.project_id,
                docs: fullDocs,
            };

            // v0 web hooks, call when done with all the data
            if (!job.data.v1) {
                callWebhook({
                    teamId: job.data.team_id,
                    crawlId: job.data.crawl_id,
                    data,
                    webhook: job.data.webhook,
                    v1: job.data.v1,
                    eventType: job.data.crawlerOptions !== null
                        ? "crawl.completed"
                        : "batch_scrape.completed",
                });
            }
        } else {
            const num_docs = await getDoneJobsOrderedLength(job.data.crawl_id);
            const jobStatus = sc.cancelled ? "failed" : "completed";

            let credits_billed = null;

            if (process.env.USE_DB_AUTHENTICATION === "true") {
                const creditsRpc = await supabase_service
                    .rpc("credits_billed_by_crawl_id_1", {
                        i_crawl_id: job.data.crawl_id,
                    });

                credits_billed = creditsRpc.data?.[0]?.credits_billed ?? null;

                if (credits_billed === null) {
                    logger.warn("Credits billed is null", {
                        error: creditsRpc.error,
                    });
                }
            }

            await logJob(
                {
                    job_id: job.data.crawl_id,
                    success: jobStatus === "completed",
                    message: sc.cancelled ? "Cancelled" : undefined,
                    num_docs,
                    docs: [],
                    time_taken: (Date.now() - sc.createdAt) / 1000,
                    team_id: job.data.team_id,
                    scrapeOptions: sc.scrapeOptions,
                    mode: job.data.crawlerOptions !== null ? "crawl" : "batch_scrape",
                    url:
                        sc?.originUrl ??
                        (job.data.crawlerOptions === null ? "Batch Scrape" : "Unknown"),
                    crawlerOptions: sc.crawlerOptions,
                    origin: job.data.origin,
                    integration: job.data.integration,
                    credits_billed,
                    zeroDataRetention: job.data.zeroDataRetention,
                },
                true,
                job.data.internalOptions?.bypassBilling ?? false,
            );


            // v1 web hooks, call when done with no data, but with event completed
            if (job.data.v1 && job.data.webhook) {
                callWebhook({
                    teamId: job.data.team_id,
                    crawlId: job.data.crawl_id,
                    data: [],
                    webhook: job.data.webhook,
                    v1: job.data.v1,
                    eventType: job.data.crawlerOptions !== null
                        ? "crawl.completed"
                        : "batch_scrape.completed",
                });
            }
        }
    }
}