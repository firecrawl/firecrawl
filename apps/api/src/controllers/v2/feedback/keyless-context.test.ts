import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  eval: vi.fn(),
  attempts: vi.fn(),
  today: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("./keyless-redis", () => ({
  keylessFeedbackRedis: { set: mocks.set, eval: mocks.eval },
}));
vi.mock("./keyless-store", () => ({ hasKeylessFeedbackToday: mocks.today }));
vi.mock("../../../services/rate-limiter", () => ({
  redisRateLimitClient: { get: mocks.attempts },
}));
vi.mock("../../../lib/logger", () => ({
  logger: { info: mocks.info, warn: mocks.warn },
}));
vi.mock("../../../lib/keyless", () => ({ keylessTeamUuid: () => "identity" }));
vi.mock("../../../lib/zdr-helpers", () => ({
  getScrapeZDR: () => null,
  getSearchZDR: () => null,
}));
vi.mock("../../../config", () => ({
  config: {
    KEYLESS_FEEDBACK_ENABLED: true,
    USE_DB_AUTHENTICATION: true,
    KEYLESS_FEEDBACK_INVITATION_EVERY: 1,
  },
}));
import { keylessFeedbackMetadata } from "./keyless-context";

describe("keyless feedback invitation issuance", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.set.mockResolvedValue("OK");
    mocks.eval.mockResolvedValue(1);
    mocks.attempts.mockResolvedValue(null);
    mocks.today.mockResolvedValue(false);
  });
  afterEach(() => vi.useRealTimers());
  const prepare = (res: EventEmitter, headers = {}) =>
    keylessFeedbackMetadata(
      {
        auth: { team_id: "fixture" },
        res,
        headers,
        body: { origin: "mcp", integration: "fixture" },
      } as any,
      "scrape",
      "job",
      true,
      { markdown: "Example" },
    );

  it("records issuance independently of submissions only after the response finishes", async () => {
    const response = new EventEmitter();
    const metadata = await prepare(response);
    expect(metadata.feedback).toBeDefined();
    expect(JSON.parse(mocks.set.mock.calls[0][1]).invited).toBe(false);
    expect(mocks.info).not.toHaveBeenCalled();
    response.emit("finish");
    response.emit("finish");
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info.mock.calls[0][1]).toMatchObject({
      canonicalLog: "keyless/feedback_invitation",
      invited: true,
      identity: "identity",
      endpoint: "scrape",
      jobId: "job",
      origin: "mcp",
    });
    expect(JSON.parse(mocks.set.mock.calls[1][1]).invited).toBe(true);
    expect(mocks.set.mock.calls[1].slice(2)).toEqual(["KEEPTTL", "XX"]);
  });

  it("does not count a disconnected response", async () => {
    const response = new EventEmitter();
    await prepare(response);
    response.emit("close");
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.set).toHaveBeenCalledTimes(1);
  });

  it("keeps job references but does not invite opted-out clients", async () => {
    const response = new EventEmitter();
    expect(await prepare(response, { "x-firecrawl-no-feedback": "1" })).toEqual(
      { jobId: "job" },
    );
    response.emit("finish");
    expect(mocks.eval).not.toHaveBeenCalled();
    expect(mocks.today).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("does not record an invitation after an eligibility check outlives the response budget", async () => {
    vi.useFakeTimers();
    let release!: (value: boolean) => void;
    mocks.today.mockImplementation(
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
    expect(mocks.set).toHaveBeenCalledTimes(1);
  });

  it("preserves the reference when invitation eligibility fails", async () => {
    mocks.today.mockRejectedValueOnce(new Error("database unavailable"));
    const response = new EventEmitter();
    expect(await prepare(response)).toEqual({ jobId: "job" });
    response.emit("finish");
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("does not increment the invitation counter after a slow snapshot write", async () => {
    vi.useFakeTimers();
    let release!: (value: string) => void;
    mocks.set.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const pending = prepare(new EventEmitter());
    await vi.advanceTimersByTimeAsync(251);
    expect(await pending).toEqual({ jobId: "job" });
    release("OK");
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it.each(["search", "scrape", "parse"] as const)(
    "bounds %s context and preserves job references and Search positions",
    async endpoint => {
      const document = {
        markdown: "Observed output ".repeat(100000),
        toJSON() {
          throw new Error("Must not serialize the complete document");
        },
      };
      const result =
        endpoint === "search"
          ? {
              web: Array.from({ length: 100 }, () => ({
                url: "https://example.com/",
                description: document.markdown,
              })),
            }
          : document;
      const metadata = await keylessFeedbackMetadata(
        {
          auth: { team_id: "fixture" },
          body: {
            url: "https://user:password@example.com/page?credential=secret#secret",
            actions: [
              { type: "write", text: "form-secret" },
              { type: "executeJavascript", script: "script-secret" },
            ],
            headers: { Authorization: "header-secret" },
          },
        } as any,
        endpoint,
        "job",
        true,
        result,
      );
      expect(metadata.jobId).toBe("job");
      const encoded = mocks.set.mock.calls[0][1];
      expect(Buffer.byteLength(encoded)).toBeLessThan(64 * 1024);
      expect(encoded).not.toContain("secret");
      expect(encoded).not.toContain("password");
      const context = JSON.parse(encoded);
      expect(context.request.url).toBe("https://example.com/page");
      expect(context.request.actions).toEqual([
        { type: "write" },
        { type: "executeJavascript" },
      ]);
      expect(context.result.truncated).toBe(true);
      if (endpoint === "search") {
        expect(context.result.web).toHaveLength(100);
        expect(context.result.web[99].position).toBe(100);
      } else {
        expect(context.result.markdown.length).toBeLessThanOrEqual(16000);
      }
    },
  );

  it("keeps escaped and multibyte request and result snapshots below the storage cap", async () => {
    const large = "\u0000😀".repeat(100000);
    const metadata = await keylessFeedbackMetadata(
      {
        auth: { team_id: "fixture" },
        body: { query: large, nested: { value: large } },
      } as any,
      "parse",
      "job",
      true,
      { json: { text: large }, markdown: large },
    );
    expect(metadata.jobId).toBe("job");
    const encoded = mocks.set.mock.calls[0][1];
    expect(Buffer.byteLength(encoded)).toBeLessThan(64 * 1024);
    const stored = JSON.parse(encoded);
    expect(stored.request.truncated).toBe(true);
    expect(stored.result.truncated).toBe(true);
  });

  it("retains the issuance event and reports a failed context update", async () => {
    const response = new EventEmitter();
    await prepare(response);
    mocks.set.mockRejectedValueOnce(new Error("cache unavailable"));
    response.emit("finish");
    await vi.waitFor(() => expect(mocks.warn).toHaveBeenCalledTimes(1));
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it("does not offer feedback when snapshot storage fails", async () => {
    mocks.set.mockRejectedValueOnce(new Error("cache unavailable"));
    const response = new EventEmitter();
    expect(await prepare(response)).toEqual({ jobId: "job" });
    response.emit("finish");
    expect(mocks.info).not.toHaveBeenCalled();
  });
});
