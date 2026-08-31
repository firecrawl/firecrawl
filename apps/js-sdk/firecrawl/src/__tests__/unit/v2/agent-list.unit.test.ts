import { describe, expect, jest, test } from "@jest/globals";
import { listAgents } from "../../../v2/methods/agent";

describe("v2.agent listAgents unit", () => {
  const sampleAgent = {
    id: "018f3c5e-0000-7000-8000-000000000000",
    createdAt: "2026-08-31T12:00:00.000Z",
    targetHint: "https://example.com",
    origin: "api",
    settings: { hidden: false, starred: false },
    status: "completed",
    options: {
      urls: ["https://example.com"],
      prompt: "Find the pricing",
      model: "spark-1-pro",
    },
  };

  test("hits GET /v2/agent without query by default", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: { success: true, agents: [sampleAgent] },
    });

    const res = await listAgents({ get } as any);

    expect(get).toHaveBeenCalledWith("/v2/agent");
    expect(res.success).toBe(true);
    expect(res.agents).toHaveLength(1);
    expect(res.agents![0].id).toBe(sampleAgent.id);
    expect(res.agents![0].settings.starred).toBe(false);
    expect(res.next).toBeUndefined();
  });

  test("passes before as a query param", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        agents: [sampleAgent],
        next: "https://api.firecrawl.dev/v2/agent?before=1756600000000",
      },
    });

    const res = await listAgents({ get } as any, { before: 1756600000000 });

    expect(get).toHaveBeenCalledWith("/v2/agent?before=1756600000000");
    expect(res.next).toBe(
      "https://api.firecrawl.dev/v2/agent?before=1756600000000",
    );
  });

  test("does not auto-paginate when next is present", async () => {
    const get = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        success: true,
        agents: [sampleAgent],
        next: "https://api.firecrawl.dev/v2/agent?before=1756600000000",
      },
    });

    const res = await listAgents({ get } as any);

    expect(get).toHaveBeenCalledTimes(1);
    expect(res.agents).toHaveLength(1);
  });
});
