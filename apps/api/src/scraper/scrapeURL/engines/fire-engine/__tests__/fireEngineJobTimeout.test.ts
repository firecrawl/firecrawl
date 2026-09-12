import { vi } from "vitest";

vi.mock("@mendable/firecrawl-rs", () => ({}));

import { fireEngineJobTimeout } from "..";
import type { Meta } from "../../..";

describe("fireEngineJobTimeout", () => {
  it("budgets a scrape with no timeout to the waterfall wait plus slack, not 300s", () => {
    const meta = {
      abort: { scrapeTimeout: () => undefined },
      options: { formats: [], waitFor: 0 },
    } as unknown as Meta;

    expect(fireEngineJobTimeout(meta, "chrome-cdp")).toBe(60000);
  });
});
