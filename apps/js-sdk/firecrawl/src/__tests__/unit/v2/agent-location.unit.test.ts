import { describe, test, expect, vi } from "vitest";
import { startAgent } from "../../../v2/methods/agent";

describe("JS SDK v2 agent location", () => {
  const post = () =>
    vi.fn(async () => ({
      status: 200,
      data: { success: true, id: "agent-1" },
    }));

  test("sends location when starting an agent", async () => {
    const http = { post: post() };

    await startAgent(http as any, {
      prompt: "Find the pricing page",
      location: { country: "DE" },
    });

    expect(http.post).toHaveBeenCalledWith("/v2/agent", {
      prompt: "Find the pricing page",
      location: { country: "DE" },
    });
  });

  test("omits location by default", async () => {
    const http = { post: post() };

    await startAgent(http as any, { prompt: "Find the pricing page" });

    expect(http.post).toHaveBeenCalledWith("/v2/agent", {
      prompt: "Find the pricing page",
    });
  });
});
