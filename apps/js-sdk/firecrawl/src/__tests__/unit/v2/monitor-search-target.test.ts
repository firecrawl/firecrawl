/**
 * Unit test: a search-target monitor request is forwarded intact to the API.
 */
import { describe, test, expect } from "vitest";
import { createMonitor } from "../../../v2/methods/monitor";
import type { CreateMonitorRequest, MonitorSearchTarget } from "../../../v2/types";

describe("v2 monitor search target", () => {
  test("createMonitor forwards a search target with its camelCase fields", async () => {
    let captured: any;
    const http: any = {
      post: async (_path: string, body: any) => {
        captured = body;
        return { status: 200, data: { success: true, data: { id: "mon_1", ...body } } };
      },
    };

    const searchTarget: MonitorSearchTarget = {
      type: "search",
      queries: ["firecrawl launch"],
      searchWindow: "24h",
      includeDomains: ["firecrawl.dev"],
      excludeDomains: ["spam.com"],
      maxResults: 20,
    };

    const request: CreateMonitorRequest = {
      name: "Search monitor",
      schedule: { text: "every 30 minutes" },
      goal: "Alert when Firecrawl launches a product",
      targets: [searchTarget],
    };

    await createMonitor(http, request);

    expect(captured.targets[0]).toEqual(searchTarget);
    expect(captured.targets[0].type).toBe("search");
    expect(captured.targets[0].searchWindow).toBe("24h");
    expect(captured.targets[0].maxResults).toBe(20);
  });
});
