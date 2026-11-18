import { beforeEach, describe, expect, it, vi } from "vitest";

const { returning, capturePostHog } = vi.hoisted(() => ({
  returning: vi.fn(),
  capturePostHog: vi.fn(),
}));

vi.mock("../db/connection", () => {
  const chain: any = {
    insert: () => chain,
    values: () => chain,
    onConflictDoNothing: () => chain,
    returning,
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: async () => [],
  };
  return { db: chain, dbRr: chain };
});
vi.mock("./posthog-capture", () => ({
  capturePostHog,
  isPostHogCaptureEnabled: () => true,
}));

import { trackFirstSurfaceUse } from "./posthog";

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const args = (teamId: string, origin = "js-sdk@1.0.0") => ({
  teamId,
  origin,
  kind: "scrape",
  apiVersion: "v2",
});

describe("trackFirstSurfaceUse", () => {
  beforeEach(() => {
    returning.mockReset();
    capturePostHog.mockReset();
  });

  it("emits only when the insert created the row, then skips from cache", async () => {
    returning.mockResolvedValue([{ team_id: "team-a" }]);
    trackFirstSurfaceUse(args("team-a"));
    await flush();
    trackFirstSurfaceUse(args("team-a"));
    await flush();

    expect(returning).toHaveBeenCalledTimes(1);
    expect(capturePostHog).toHaveBeenCalledTimes(1);
    expect(capturePostHog.mock.calls[0][2]).toMatchObject({ surface: "sdk" });
  });

  it("does not emit when the pair already exists", async () => {
    returning.mockResolvedValue([]);
    trackFirstSurfaceUse(args("team-b"));
    await flush();
    trackFirstSurfaceUse(args("team-b"));
    await flush();

    expect(returning).toHaveBeenCalledTimes(1);
    expect(capturePostHog).not.toHaveBeenCalled();
  });

  it("fails open on a DB error without emitting, and retries later", async () => {
    returning.mockRejectedValueOnce(new Error("db down"));
    trackFirstSurfaceUse(args("team-c"));
    await flush();
    expect(capturePostHog).not.toHaveBeenCalled();

    returning.mockResolvedValue([{ team_id: "team-c" }]);
    trackFirstSurfaceUse(args("team-c"));
    await flush();
    expect(capturePostHog).toHaveBeenCalledTimes(1);
  });

  it("keys the dedupe by surface", async () => {
    returning.mockResolvedValue([{ team_id: "team-d" }]);
    trackFirstSurfaceUse(args("team-d", "website"));
    trackFirstSurfaceUse(args("team-d", "api"));
    await flush();

    expect(returning).toHaveBeenCalledTimes(2);
  });
});
