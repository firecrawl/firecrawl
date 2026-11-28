import { describe, expect, it, vi } from "vitest";
import { getCrawlStatus } from "../../../v2/methods/crawl";
import { getBatchScrapeStatus } from "../../../v2/methods/batch";
import { getMonitorCheck } from "../../../v2/methods/monitor";

describe.each(["crawl", "batch", "monitor"] as const)(
  "%s pagination cursor cycles",
  (kind) => {
    it.each([2, 3])(
      "fetches each page once in a %i-page cycle",
      async (length) => {
        const item = (name: string) =>
          kind === "monitor"
            ? { url: `https://example.com/${name}`, status: "changed" }
            : { markdown: name };
        const response = (name: string, next: string) => ({
          status: 200,
          data: {
            success: true,
            status: "completed",
            completed: length + 1,
            total: length + 1,
            next,
            data:
              kind === "monitor"
                ? {
                    id: "check",
                    monitorId: "monitor",
                    status: "completed",
                    pages: [item(name)],
                    next,
                  }
                : [item(name)],
          },
        });
        const firstCursor = "https://api.example/next/0";
        const get = vi.fn(async (url: string) => {
          // Bound a broken implementation without relying on a wall-clock timeout.
          if (get.mock.calls.length > 10)
            throw new Error("fixture request budget exhausted");
          if (!url.startsWith("https://api.example/next/"))
            return response("initial", firstCursor);
          const index = Number(url.split("/").at(-1));
          return response(
            `page-${index}`,
            `https://api.example/next/${(index + 1) % length}`,
          );
        });
        const http = { get } as any;
        const result =
          kind === "crawl"
            ? await getCrawlStatus(http, "job")
            : kind === "batch"
              ? await getBatchScrapeStatus(http, "job")
              : await getMonitorCheck(http, "monitor", "check");
        const values = "pages" in result ? result.pages : result.data;

        expect(values).toEqual([
          item("initial"),
          ...Array.from({ length }, (_, index) => item(`page-${index}`)),
        ]);
        expect(get).toHaveBeenCalledTimes(length + 1);
        expect(get.mock.calls.slice(1).map(([url]) => url)).toEqual(
          Array.from(
            { length },
            (_, index) => `https://api.example/next/${index}`,
          ),
        );
        expect(result.next).toBeNull();
      },
    );
  },
);
