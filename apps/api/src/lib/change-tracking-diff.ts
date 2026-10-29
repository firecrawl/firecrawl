import { createTwoFilesPatch } from "diff";
import parseDiff from "parse-diff";

type StructuredMarkdownDiff = {
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

export function createMarkdownChangeDiff(
  previousMarkdown: string,
  currentMarkdown: string,
): { text: string; json: StructuredMarkdownDiff } | undefined {
  const text = createTwoFilesPatch(
    "previous.md",
    "current.md",
    previousMarkdown,
    currentMarkdown,
    "",
    "",
    { context: 3 },
  );

  const structured = parseDiff(text);
  const hasChanges = structured.some(file =>
    file.chunks.some(chunk =>
      chunk.changes.some(
        change => change.type === "add" || change.type === "del",
      ),
    ),
  );

  if (!hasChanges) return undefined;

  return {
    text,
    json: {
      files: structured.map(file => ({
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
            }
            if (change.type === "add" && "ln" in change) {
              return {
                ...baseChange,
                add: true,
                ln: change.ln,
              };
            }
            if (change.type === "del" && "ln" in change) {
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
