import gitDiff from "git-diff";
import parseDiff from "parse-diff";

type MonitoringDiffResult =
  | {
      status: "same";
      text?: undefined;
      json?: undefined;
    }
  | {
      status: "changed";
      text: string;
      json: {
        files: Array<{
          from: string | null;
          to: string | null;
          chunks: Array<{
            content: string;
            changes: Array<{
              type: string;
              normal?: boolean;
              add?: boolean;
              del?: boolean;
              ln?: number;
              ln1?: number;
              ln2?: number;
              content: string;
            }>;
          }>;
        }>;
      };
    };

function normalizeMarkdownForChangeTracking(markdown: string): string {
  return [...markdown.replace(/\s+/g, "").replace(/\[iframe\]\(.+?\)/g, "")]
    .sort()
    .join("");
}

export function diffMonitorMarkdown(
  previousMarkdown: string,
  currentMarkdown: string,
): MonitoringDiffResult {
  if (
    normalizeMarkdownForChangeTracking(previousMarkdown) ===
    normalizeMarkdownForChangeTracking(currentMarkdown)
  ) {
    return { status: "same" };
  }

  const text = gitDiff(previousMarkdown, currentMarkdown, {
    color: false,
    wordDiff: false,
  });
  const structured = parseDiff(text);

  return {
    status: "changed",
    text,
    json: {
      files: structured.map(file => ({
        from: file.from || null,
        to: file.to || null,
        chunks: file.chunks.map(chunk => ({
          content: chunk.content,
          changes: chunk.changes.map(change => {
            const base = {
              type: change.type,
              content: change.content,
            };

            if (
              change.type === "normal" &&
              "ln1" in change &&
              "ln2" in change
            ) {
              return {
                ...base,
                normal: true,
                ln1: change.ln1,
                ln2: change.ln2,
              };
            }
            if (change.type === "add" && "ln" in change) {
              return {
                ...base,
                add: true,
                ln: change.ln,
              };
            }
            if (change.type === "del" && "ln" in change) {
              return {
                ...base,
                del: true,
                ln: change.ln,
              };
            }

            return base;
          }),
        })),
      })),
    },
  };
}
