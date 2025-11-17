import { supabase_service } from "../../../services/supabase";
import { Document } from "../../../controllers/v1/types";
import { Meta } from "../index";
import { getJob } from "../../../controllers/v1/crawl-status";
import gitDiff from "git-diff";
import parseDiff from "parse-diff";
import { generateCompletions } from "./llmExtract";
import { hasFormatOfType } from "../../../lib/format-utils";

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
    const res = await supabase_service.rpc("diff_get_last_scrape_v7", {
      i_team_id: meta.internalOptions.teamId,
      i_url: document.metadata.sourceURL ?? meta.rewrittenUrl ?? meta.url,
      i_tag: changeTrackingFormat?.tag ?? null,
    });
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

    const data:
      | {
          o_job_id: string;
          o_date_added: string;
        }
      | undefined
      | null = (res.data ?? [])[0] as any;

    const job: {
      returnvalue: Document;
    } | null = data?.o_job_id ? await getJob(data.o_job_id) : null;
    if (data && job && job?.returnvalue) {
      const previousMarkdown = job.returnvalue.markdown!;
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
        previousScrapeAt: data.o_date_added,
        changeStatus,
        visibility: meta.internalOptions.urlInvisibleInCurrentCrawl
          ? "hidden"
          : "visible",
      };

      if (
        changeTrackingFormat?.modes?.includes("git-diff") &&
        changeStatus === "changed"
      ) {
        const diffText = gitDiff(previousMarkdown, currentMarkdown, {
          color: false,
          wordDiff: false,
        });
        // meta.logger.debug("Diff text", { diffText });
        if (diffText) {
          const diffStructured = parseDiff(diffText);
          // meta.logger.debug("Diff structured", { diffStructured });
          document.changeTracking.diff = {
            text: diffText,
            json: {
              files: diffStructured.map(file => ({
                from: file.from || null,
                to: file.to || null,
                chunks: file.chunks.map(chunk => ({
                  content: chunk.content,
                  changes: chunk.changes.map(change => {
                    const baseChange = {
                      type: change.type,
                      content: change.content,
                    };

                    if (
                      change.type === "normal" &&
                      "ln1" in change &&
                      "ln2" in change
                    ) {
                      return {
                        ...baseChange,
                        normal: true,
                        ln1: change.ln1,
                        ln2: change.ln2,
                      };
                    } else if (change.type === "add" && "ln" in change) {
                      return {
                        ...baseChange,
                        add: true,
                        ln: change.ln,
                      };
                    } else if (change.type === "del" && "ln" in change) {
                      return {
                        ...baseChange,
                        del: true,
                        ln: change.ln,
                      };
                    }

                    return baseChange;
                  }),
                })),
              })),
            },
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
    } else if (!res.error) {
      document.changeTracking = {
        previousScrapeAt: null,
        changeStatus: document.metadata.statusCode === 404 ? "removed" : "new",
        visibility: meta.internalOptions.urlInvisibleInCurrentCrawl
          ? "hidden"
          : "visible",
      };
    } else {
      meta.logger.error("Error fetching previous scrape", { error: res.error });
      document.warning =
        "Comparing failed, please try again later." +
        (document.warning ? ` ${document.warning}` : "");
    }
  }

  return document;
}
