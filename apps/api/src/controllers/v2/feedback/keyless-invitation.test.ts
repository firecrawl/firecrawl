import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  attempts: vi.fn(),
  today: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("./keyless-store", () => ({ hasKeylessFeedbackToday: mocks.today }));
vi.mock("../../../services/rate-limiter", () => ({
  redisRateLimitClient: { get: mocks.attempts, eval: mocks.eval },
}));
vi.mock("../../../lib/logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn },
}));
vi.mock("../../../lib/keyless", () => ({
  keylessTeamUuid: (team: string) => (team === "fixture" ? "identity" : null),
}));
vi.mock("../../../config", () => ({
  config: {
    KEYLESS_FEEDBACK_ENABLED: true,
    USE_DB_AUTHENTICATION: true,
    KEYLESS_FEEDBACK_INVITATION_EVERY: 1,
  },
}));
import { config } from "../../../config";
import { keylessFeedbackMetadata } from "./keyless-invitation";

describe("keyless feedback invitations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    config.KEYLESS_FEEDBACK_ENABLED = true;
    config.USE_DB_AUTHENTICATION = true;
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 1;
    mocks.eval.mockResolvedValue(1);
    mocks.attempts.mockResolvedValue(null);
    mocks.today.mockResolvedValue(false);
  });
  afterEach(() => vi.useRealTimers());
  const prepare = (res = new EventEmitter(), overrides = {}) =>
    keylessFeedbackMetadata(
      {
        auth: { team_id: "fixture" },
        res,
        body: { origin: "mcp", integration: "fixture" },
        ...overrides,
      } as any,
      "scrape",
      "job",
      true,
    );

  it("records issuance once, only after the response finishes", async () => {
    const response = new EventEmitter();
    expect((await prepare(response)).feedback).toBeDefined();
    expect(mocks.info).not.toHaveBeenCalled();
    response.emit("finish");
    response.emit("finish");
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info.mock.calls[0][1]).toMatchObject({
      canonicalLog: "keyless/feedback_invitation",
      identity: "identity",
      endpoint: "scrape",
      jobId: "job",
      origin: "mcp",
    });
  });

  it("does not record a disconnected response", async () => {
    const response = new EventEmitter();
    await prepare(response);
    response.emit("close");
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it.each(["KEYLESS_FEEDBACK_ENABLED", "USE_DB_AUTHENTICATION"] as const)(
    "preserves the job reference when %s is off",
    async key => {
      config[key] = false;
      expect(await prepare()).toEqual({ jobId: "job" });
      expect(mocks.eval).not.toHaveBeenCalled();
    },
  );

  it("does not add keyless metadata for authenticated jobs", async () => {
    expect(
      await prepare(undefined, { auth: { team_id: "authenticated" } }),
    ).toEqual({});
    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it.each([
    { body: { zeroDataRetention: true } },
    { body: { lockdown: true } },
    { body: { enterprise: ["zdr"] } },
    { body: { enterprise: ["anon"] } },
    { acuc: { flags: { searchZDR: "forced-anon" } } },
    { acuc: { flags: { scrapeZDR: "forced" } } },
    { acuc: { flags: { searchFeedbackOptOut: true } } },
  ])(
    "preserves the reference without inviting restricted jobs: %j",
    async overrides => {
      expect(await prepare(undefined, overrides)).toEqual({ jobId: "job" });
      expect(mocks.eval).not.toHaveBeenCalled();
    },
  );

  it("does not invite Search jobs with nested lockdown", async () => {
    expect(
      await keylessFeedbackMetadata(
        {
          auth: { team_id: "fixture" },
          body: { scrapeOptions: { lockdown: true } },
        } as any,
        "search",
        "job",
        true,
      ),
    ).toEqual({ jobId: "job" });
    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it("shares invitation cadence across categories and clients", async () => {
    config.KEYLESS_FEEDBACK_INVITATION_EVERY = 3;
    const counts = new Map<string, number>();
    mocks.eval.mockImplementation(async (_script, _keys, key: string) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count;
    });
    const endpoints = ["search", "scrape", "parse"] as const;
    for (let index = 0; index < 6; index++) {
      const metadata = await keylessFeedbackMetadata(
        {
          auth: { team_id: "fixture" },
          body: { origin: ["api", "cli", "mcp"][index % 3] },
        } as any,
        endpoints[index % 3],
        `job-${index}`,
        true,
      );
      expect(metadata.jobId).toBe(`job-${index}`);
      expect(Boolean(metadata.feedback)).toBe((index + 1) % 3 === 0);
    }
    expect(counts.size).toBe(1);
  });

  it("does not let caller headers suppress keyless invitations", async () => {
    expect(
      (
        await prepare(undefined, {
          headers: { "x-firecrawl-no-feedback": "1" },
        })
      ).feedback,
    ).toBeDefined();
  });

  it("suppresses invitations after acceptance or excessive attempts", async () => {
    mocks.today.mockResolvedValueOnce(true);
    expect(await prepare()).toEqual({ jobId: "job" });
    mocks.attempts.mockResolvedValueOnce("10");
    expect(await prepare()).toEqual({ jobId: "job" });
  });

  it("preserves the reference when invitation eligibility fails", async () => {
    mocks.today.mockRejectedValueOnce(new Error("database unavailable"));
    expect(await prepare()).toEqual({ jobId: "job" });
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("does not record an invitation after a timed-out eligibility check", async () => {
    vi.useFakeTimers();
    let release!: (value: boolean) => void;
    mocks.today.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const response = new EventEmitter();
    const pending = prepare(response);
    await vi.advanceTimersByTimeAsync(251);
    expect(await pending).toEqual({ jobId: "job" });
    response.emit("finish");
    release(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("does not inspect uploaded content when creating invitations", async () => {
    const metadata = await keylessFeedbackMetadata(
      {
        auth: { team_id: "fixture" },
        body: {
          get file() {
            throw new Error("Document must not be read");
          },
        },
      } as any,
      "parse",
      "job",
      true,
    );
    expect(metadata.feedback).toBeDefined();
  });
});
