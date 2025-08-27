import "dotenv/config";
import { supabase_service } from "../../../services/supabase";
import { removeJobFromGCS } from "../../../lib/gcs-jobs";
import { Request, Response } from "express";
import { logger as _logger } from "../../../lib/logger";
import type { Logger } from "winston";

async function cleanUpJob(jobId: string) {
    await removeJobFromGCS(jobId);
}

async function cleanUp(specificTeamId: string | null, _logger: Logger) {
    const logger = _logger.child({
        ...(specificTeamId ? { teamId: specificTeamId } : {}),
        method: "cleanUp",
    });

    const cleanedUp: number[] = [];

    try {
        for (let i = 0; ; i++) {
            let selector = supabase_service.from("firecrawl_jobs")
                .select("id, job_id");
            
            if (specificTeamId) {
                selector = selector.eq("team_id", specificTeamId).not("dr_clean_by", "is", null);
            } else {
                selector = selector
                    .lte("dr_clean_by", new Date().toISOString())
                    .gte("dr_clean_by", new Date(Date.now() - 1000 * 60 * 60 * 24 * 7).toISOString());
                // Explanation for the gte: since the cleaner should run every 5 minutes, it is very unlikely that
                // the cleaner will be down for 7 days without anyone noticing.
                // Since the firecrawl_jobs table is incredibly large, even with the index on dr_clean_by,
                // not giving the select a lower bound guarantees that the select will not run with an empty result
                // in reasonable time.
                // Therefore, we give it a lower bound which should never cause problems.
            }

            const { data: jobs } = await selector
                .range(i * 1000, (i + 1) * 1000)
                .throwOnError();
    
            if (jobs?.length === 0) {
                break;
            }

            for (let i = 0; i < Math.ceil((jobs?.length ?? 0) / 50); i++) {
                const theseJobs = (jobs ?? []).slice(i * 50, (i + 1) * 50);
                await Promise.allSettled(theseJobs.map(async (job) => {
                    try {
                        await cleanUpJob(job.job_id);
                        cleanedUp.push(job.id);
                    } catch (error) {
                        logger.error(`Error cleaning up job`, {
                            method: "cleanUpJob",
                            jobId: job.job_id,
                            scrapeId: job.job_id,
                            error,
                        });
                        throw error;
                    }
                }) ?? []);
            }
    
            if ((jobs ?? []).length < 1000) {
                break;
            }
        }
    } catch (error) {
        logger.error(`Error looping through jobs`, {
            error,
        });
    }

    if (cleanedUp.length > 0) {
        try {
            await supabase_service.from("firecrawl_jobs")
                .update({
                    dr_clean_by: null,
                })
                .in("id", cleanedUp)
                .throwOnError();
        } catch (error) {
            logger.error(`Error setting cleanup value on team`, {
                error,
            });
        }
    }
}

export async function zdrcleanerController(req: Request, res: Response) {
    const logger = _logger.child({
        module: "zdrcleaner",
        method: "zdrcleanerController",
    });

    await cleanUp((req.query.teamId as string | undefined) ?? null, logger);

    logger.info("ZDR Cleaner finished!");

    res.json({ ok: true })
}