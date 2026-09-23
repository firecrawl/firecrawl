import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
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
  },
}));
import { config } from "../../../config";
import { keylessFeedbackMetadata } from "./keyless-invitation";

describe("keyless feedback invitations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    config.KEYLESS_FEEDBACK_ENABLED = true;
    config.USE_DB_AUTHENTICATION = true;
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
    },
  );

  it("does not add keyless metadata for authenticated jobs", async () => {
    expect(
      await prepare(undefined, { auth: { team_id: "authenticated" } }),
    ).toEqual({});
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
      ),
    ).toEqual({ jobId: "job" });
  });

  it("includes the contract on every eligible response across endpoints and clients", async () => {
    const endpoints = ["search", "scrape", "parse"] as const;
    for (let index = 0; index < 6; index++) {
      const metadata = keylessFeedbackMetadata(
        {
          auth: { team_id: "fixture" },
          body: { origin: ["api", "cli", "mcp"][index % 3] },
        } as any,
        endpoints[index % 3],
        `job-${index}`,
      );
      expect(metadata).toMatchObject({
        jobId: `job-${index}`,
        feedback: {
          docs: "https://docs.firecrawl.dev/api-reference/endpoint/feedback",
          message: expect.stringContaining("free in exchange for feedback"),
        },
      });
      expect((metadata.feedback as { message: string }).message).not.toMatch(
        /limit|per day|UTC|optional|after your task/i,
      );
    }
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
    );
    expect(metadata.feedback).toBeDefined();
  });
});
