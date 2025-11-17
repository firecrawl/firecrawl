import { supabase_service } from "../supabase";
import { FirecrawlJob } from "../../types";
import { posthog } from "../posthog";
import "dotenv/config";
import { logger as _logger } from "../../lib/logger";
import { configDotenv } from "dotenv";
import { saveJobToGCS } from "../../lib/gcs-jobs";
import { saveJobToBigQuery } from "../../lib/bigquery-jobs";
import {
  transformJobForLogging,
  createJobLoggerContext,
} from "../../lib/job-transform";
import { withSpan, setSpanAttributes } from "../../lib/otel-tracer";
import { hasFormatOfType } from "../../lib/format-utils";
configDotenv();

export async function logJob(
  job: FirecrawlJob,
  force: boolean = false,
  bypassLogging: boolean = false,
) {
  let logger = _logger.child({
    module: "log_job",
    method: "logJob",
    ...createJobLoggerContext(job),
  });

  const zeroDataRetention = job.zeroDataRetention ?? false;

  logger = logger.child({
    zeroDataRetention,
  });

  try {
    // Save to GCS if configured
    if (process.env.GCS_BUCKET_NAME) {
      await withSpan("firecrawl-log-job-save-to-gcs", async span => {
        setSpanAttributes(span, {
          "log_job.operation": "save_to_gcs",
          "job.id": job.job_id,
          "job.team_id": job.team_id,
        });
        await saveJobToGCS(job);
      });
    }

    // Save to BigQuery if configured
    if (process.env.BIGQUERY_DATASET_ID) {
      withSpan("firecrawl-log-job-save-to-bigquery", async span => {
        setSpanAttributes(span, {
          "log_job.operation": "save_to_bigquery",
          "job.id": job.job_id,
          "job.team_id": job.team_id,
          "job.force": force,
        });
        await saveJobToBigQuery(job, force);
      }).catch(error => {
        logger.error("Error saving job to BigQuery", { error });
      });
    }

    const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === "true";
    if (!useDbAuthentication) {
      return;
    }

    // Redact any pages that have an authorization header
    // actually, Don't. we use the db to retrieve results now. this breaks authed crawls - mogery
    // if (
    //   job.scrapeOptions &&
    //   job.scrapeOptions.headers &&
    //   job.scrapeOptions.headers["Authorization"]
    // ) {
    //   job.scrapeOptions.headers["Authorization"] = "REDACTED";
    //   job.docs = [
    //     {
    //       content: "REDACTED DUE TO AUTHORIZATION HEADER",
    //       html: "REDACTED DUE TO AUTHORIZATION HEADER",
    //     },
    //   ];
    // }
    const jobColumn = transformJobForLogging(job, {
      includeTimestamp: false,
      serializeObjects: false,
      cleanNullValues: true,
    });

    if (bypassLogging) {
      return;
    }

    if (force) {
      await withSpan("firecrawl-log-job-supabase-force-insert", async span => {
        setSpanAttributes(span, {
          "log_job.operation": "supabase_force_insert",
          "job.id": job.job_id,
          "job.team_id": job.team_id,
          "job.force": true,
        });

        let i = 0,
          done = false;
        while (i++ <= 10) {
          try {
            const { error } = await supabase_service
              .from("firecrawl_jobs")
              .insert([jobColumn]);
            if (error) {
              logger.error(
                "Failed to log job due to Supabase error -- trying again",
                { error },
              );
              await new Promise<void>(resolve =>
                setTimeout(() => resolve(), 75),
              );
            } else {
              done = true;
              break;
            }
          } catch (error) {
            logger.error(
              "Failed to log job due to thrown error -- trying again",
              { error },
            );
            await new Promise<void>(resolve => setTimeout(() => resolve(), 75));
          }
        }

        setSpanAttributes(span, { "supabase.insert_successful": done });
        if (done) {
          logger.debug("Job logged successfully!");
        } else {
          logger.error("Failed to log job!");
        }
      });
    } else {
      await withSpan("firecrawl-log-job-supabase-insert", async span => {
        setSpanAttributes(span, {
          "log_job.operation": "supabase_insert",
          "job.id": job.job_id,
          "job.team_id": job.team_id,
          "job.force": false,
        });

        const { error } = await supabase_service
          .from("firecrawl_jobs")
          .insert([jobColumn]);

        if (error) {
          setSpanAttributes(span, { "supabase.insert_successful": false });
          logger.error(`Error logging job`, {
            error,
          });
          throw error;
        } else {
          setSpanAttributes(span, { "supabase.insert_successful": true });
          logger.debug("Job logged successfully!");
        }
      });
    }

    // Insert into change_tracking_scrapes table if conditions are met
    if (
      job.success &&
      (job.mode === "scrape" || job.mode === "single_urls") &&
      job.url &&
      !zeroDataRetention
    ) {
      const hasMarkdown = hasFormatOfType(job.scrapeOptions?.formats, "markdown");
      const hasChangeTracking = hasFormatOfType(job.scrapeOptions?.formats, "changeTracking");
      
      // Insert if markdown format exists (either standalone or as part of change tracking)
      if (hasMarkdown || hasChangeTracking) {
        await withSpan("firecrawl-log-job-change-tracking-insert", async span => {
          setSpanAttributes(span, {
            "log_job.operation": "change_tracking_insert",
            "job.id": job.job_id,
            "job.team_id": job.team_id,
            "job.url": job.url,
            "job.change_tracking_tag": job.change_tracking_tag ?? undefined,
          });

          try {
            const { error } = await supabase_service.rpc("change_tracking_insert_scrape", {
              p_team_id: job.team_id,
              p_url: job.url,
              p_job_id: job.job_id,
              p_change_tracking_tag: job.change_tracking_tag ?? null,
              p_date_added: new Date().toISOString(),
            });

            if (error) {
              setSpanAttributes(span, { "change_tracking.insert_successful": false });
              logger.warn("Error inserting into change_tracking_scrapes", {
                error,
                jobId: job.job_id,
              });
            } else {
              setSpanAttributes(span, { "change_tracking.insert_successful": true });
              logger.debug("Change tracking record inserted successfully!");
            }
          } catch (error) {
            setSpanAttributes(span, { "change_tracking.insert_successful": false });
            logger.warn("Exception while inserting into change_tracking_scrapes", {
              error,
              jobId: job.job_id,
            });
          }
        });
      }
    }

    // if (process.env.POSTHOG_API_KEY && !job.crawl_id) {
    //   await withSpan("firecrawl-log-job-posthog-capture", async span => {
    //     setSpanAttributes(span, {
    //       "log_job.operation": "posthog_capture",
    //       "job.id": job.job_id,
    //       "job.team_id": job.team_id,
    //       "job.mode": job.mode,
    //     });

    //     const jobProperties = transformJobForLogging(job, {
    //       includeTimestamp: false,
    //       serializeObjects: false,
    //       cleanNullValues: false,
    //     });

    //     let phLog = {
    //       distinctId: "from-api", //* To identify this on the group level, setting distinctid to a static string per posthog docs: https://posthog.com/docs/product-analytics/group-analytics#advanced-server-side-only-capturing-group-events-without-a-user
    //       ...(job.team_id !== "preview" &&
    //         !job.team_id?.startsWith("preview_") && {
    //           groups: { team: job.team_id },
    //         }), //* Identifying event on this team
    //       event: "job-logged",
    //       properties: {
    //         ...jobProperties,
    //         // Remove docs from PostHog as it's not needed for analytics
    //         docs: undefined,
    //       },
    //     };

    //     if (job.mode !== "single_urls") {
    //       posthog.capture(phLog);
    //       setSpanAttributes(span, { "posthog.capture_sent": true });
    //     } else {
    //       setSpanAttributes(span, {
    //         "posthog.capture_sent": false,
    //         "posthog.skip_reason": "single_urls_mode",
    //       });
    //     }
    //   });
    // }
  } catch (error) {
    logger.error(`Error logging job`, {
      error,
    });
  }
}
