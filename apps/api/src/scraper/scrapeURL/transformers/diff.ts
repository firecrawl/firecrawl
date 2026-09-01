import { changeTrackingGetLastScrape } from "../../../lib/change-tracking-store";
import { Document } from "../../../controllers/v1/types";
import { Meta } from "../index";
import { generateCompletions } from "./llmExtract";
import { hasFormatOfType } from "../../../lib/format-utils";
import { getJobFromGCS } from "../../../lib/gcs-jobs";
import { createMarkdownChangeDiff } from "../../../lib/change-tracking-diff";

async function extractDataWithSchema(
  content: string,
  meta: Meta,
): Promise<{ extract: any } | null> {
  const changeTrackingFormat = hasFormatOfType(
    meta.options.formats,
    "changeTracking",
  )!;

  try {
    const { extract } = await generateCompletions({
      logger: meta.logger.child({
        method: "extractDataWithSchema/generateCompletions",
      }),
      options: {
        schema: changeTrackingFormat?.schema as any,
        systemPrompt:
          "Extract the requested information from the content based on the provided schema.",
        temperature: 0,
      },
      markdown: content,
      costTrackingOptions: {
        costTracking: meta.costTracking,
        metadata: {
          module: "extract",
          method: "extractDataWithSchema",
        },
      },
      metadata: {
        teamId: meta.internalOptions.teamId,
        functionId: "deriveDiff/extractDataWithSchema",
        scrapeId: meta.id,
      },
    });
    return { extract };
  } catch (error) {
    meta.logger.error("Error extracting data with schema", { error });
    return null;
  }
}

function compareExtractedData(previousData: any, currentData: any): any {
  const result: Record<string, { previous: any; current: any }> = {};

  const allKeys = new Set([
    ...Object.keys(previousData || {}),
    ...Object.keys(currentData || {}),
  ]);

  for (const key of allKeys) {
    const oldValue = previousData?.[key];
    const newValue = currentData?.[key];

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      result[key] = {
        previous: oldValue,
        current: newValue,
      };
    }
  }

  return result;
}

export async function deriveDiff(
  meta: Meta,
  document: Document,
): Promise<Document> {
  const changeTrackingFormat = hasFormatOfType(
    meta.options.formats,
    "changeTracking",
  );

  if (changeTrackingFormat) {
    if (meta.internalOptions.zeroDataRetention) {
      document.warning =
        "Change tracking is not supported with zero data retention." +
        (document.warning ? " " + document.warning : "");
      return document;
    }

    const start = Date.now();
    let last: Awaited<ReturnType<typeof changeTrackingGetLastScrape>>;
    try {
      last = await changeTrackingGetLastScrape({
        team_id: meta.internalOptions.teamId!,
        url: document.metadata.sourceURL ?? meta.rewrittenUrl ?? meta.url,
        tag: changeTrackingFormat?.tag ?? null,
      });
    } catch (error) {
      meta.logger.error("Error fetching previous scrape", { error });
      document.warning =
        "Comparing failed, please try again later." +
        (document.warning ? ` ${document.warning}` : "");
      return document;
    }
    const end = Date.now();
    if (end - start > 100) {
      meta.logger.debug("Diffing took a while", {
        time: end - start,
        params: {
          i_team_id: meta.internalOptions.teamId,
          i_url: document.metadata.sourceURL ?? meta.rewrittenUrl ?? meta.url,
        },
      });
    }

    const rawJob = last?.job_id ? await getJobFromGCS(last.job_id) : null;
    const job: Document | null = rawJob?.[0] ?? null;

    meta.logger.debug("Change tracking debugging", {
      isDataPresent: !!last,
      data: last,
      isRawJobPresent: !!rawJob,
      isJobPresent: !!job,
    });

    if (last && job) {
      const previousMarkdown = job.markdown!;
      const currentMarkdown = document.markdown!;

      const transformer = (x: string) =>
        [...x.replace(/\s+/g, "").replace(/\[iframe\]\(.+?\)/g, "")]
          .sort()
          .join("");
      const isChanged =
        transformer(previousMarkdown) !== transformer(currentMarkdown);
      const changeStatus =
        document.metadata.statusCode === 404
          ? "removed"
          : isChanged
            ? "changed"
            : "same";

      document.changeTracking = {
        previousScrapeAt: last.date_added,
        changeStatus,
        visibility: meta.internalOptions.urlInvisibleInCurrentCrawl
          ? "hidden"
          : "visible",
      };

      if (
        changeTrackingFormat?.modes?.includes("git-diff") &&
        changeStatus === "changed"
      ) {
        const diff = createMarkdownChangeDiff(
          previousMarkdown,
          currentMarkdown,
        );
        // meta.logger.debug("Diff text", { diffText: diff?.text });
        if (diff) {
          document.changeTracking.diff = {
            text: diff.text,
            json: diff.json,
          };
        }
      }

      if (
        changeTrackingFormat?.modes?.includes("json") &&
        changeStatus === "changed"
      ) {
        try {
          const previousData = changeTrackingFormat?.schema
            ? await extractDataWithSchema(previousMarkdown, meta)
            : null;

          const currentData = changeTrackingFormat?.schema
            ? await extractDataWithSchema(currentMarkdown, meta)
            : null;

          if (previousData && currentData) {
            document.changeTracking.json = compareExtractedData(
              previousData.extract,
              currentData.extract,
            );
          } else {
            const { extract } = await generateCompletions({
              logger: meta.logger.child({
                method: "deriveDiff/generateCompletions",
              }),
              options: {
                systemPrompt:
                  "Analyze the differences between the previous and current content and provide a structured summary of the changes.",
                schema: changeTrackingFormat?.schema,
                prompt: changeTrackingFormat?.prompt,
                temperature: 0,
              },
              markdown: `Previous Content:\n${previousMarkdown}\n\nCurrent Content:\n${currentMarkdown}`,
              previousWarning: document.warning,
              costTrackingOptions: {
                costTracking: meta.costTracking,
                metadata: {
                  module: "diff",
                  method: "deriveDiff",
                },
              },
              metadata: {
                teamId: meta.internalOptions.teamId,
                functionId: "deriveDiff",
                scrapeId: meta.id,
              },
            });

            document.changeTracking.json = extract;
          }
        } catch (error) {
          meta.logger.error("Error generating structured diff with LLM", {
            error,
          });
          document.warning =
            "Structured diff generation failed." +
            (document.warning ? ` ${document.warning}` : "");
        }
      }
    } else {
      document.changeTracking = {
        previousScrapeAt: null,
        changeStatus: document.metadata.statusCode === 404 ? "removed" : "new",
        visibility: meta.internalOptions.urlInvisibleInCurrentCrawl
          ? "hidden"
          : "visible",
      };
    }
  }

  return document;
}
