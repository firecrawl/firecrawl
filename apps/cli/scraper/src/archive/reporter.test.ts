import { describe, expect, it } from "vitest";
import { TextReporter } from "./reporter.js";

function capture(isTTY: boolean) {
  const chunks: string[] = [];
  return { stream: { isTTY, write: (text: string) => chunks.push(text) }, chunks };
}

describe("TextReporter", () => {
  it("prints setup steps and indented command output", () => {
    const { stream, chunks } = capture(false);
    const reporter = new TextReporter(stream);
    reporter.setup({ type: "step", label: "Local API unavailable; starting Docker Compose…" });
    reporter.setup({ type: "log", line: "Container firecrawl-api-1  Started" });
    expect(chunks.join("")).toBe(
      "Local API unavailable; starting Docker Compose…\n  Container firecrawl-api-1  Started\n",
    );
  });

  it("clears an in-place progress line first on a terminal", () => {
    const { stream, chunks } = capture(true);
    new TextReporter(stream).setup({ type: "step", label: "Starting" });
    expect(chunks).toEqual(["\r\u001B[2KStarting\n"]);
  });
});
