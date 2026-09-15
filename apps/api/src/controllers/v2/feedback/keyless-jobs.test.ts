import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  worker: vi.fn(),
  semaphore: vi.fn(),
  requestLog: vi.fn(),
  scrapeLog: vi.fn(),
}));
vi.mock("../../../services/worker/scrape-worker", () => ({
  processJobInternal: mocks.worker,
}));
vi.mock("../../../services/worker/team-semaphore", () => ({
  teamConcurrencySemaphore: { withSemaphore: mocks.semaphore },
}));
vi.mock("../../../services/logging/log_job", () => ({
  logRequest: mocks.requestLog,
  logScrape: mocks.scrapeLog,
}));
vi.mock("../../../lib/concurrency-limit", () => ({
  getEffectiveConcurrencyLimit: async () => 1,
}));
vi.mock("../../../lib/job-priority", () => ({
  getJobPriority: async () => 10,
}));
vi.mock("../../../lib/keyless-credit-projection", () => ({
  projectScrapeCredits: () => 0,
}));
vi.mock("../../../lib/permissions", () => ({ checkPermissions: () => ({}) }));
vi.mock("../../../lib/key-restriction", async importOriginal => ({
  ...(await importOriginal<typeof import("../../../lib/key-restriction")>()),
  checkKeyFormatRestriction: async () => ({ allowed: true }),
}));
vi.mock("../../../lib/threat-protection/request", () => ({
  resolveThreatProtection: async () => ({}),
}));

import { scrapeController } from "../scrape";
import { parseController } from "../parse";
import { config } from "../../../config";
import { keylessTeamId } from "../../../lib/keyless";
import { TransportableError } from "../../../lib/error";

const originalEnabled = config.KEYLESS_FEEDBACK_ENABLED;
const teamId = keylessTeamId("203.0.113.85");
const controllers = { scrape: scrapeController, parse: parseController };
function start(endpoint: keyof typeof controllers, team = teamId) {
  const req = Object.assign(new EventEmitter(), {
    auth: { team_id: team },
    acuc: { flags: {} },
    headers: {},
    path: `/v2/${endpoint}`,
    body: {
      ...(endpoint === "scrape"
        ? { url: "https://example.com/retry" }
        : {
            file: {
              filename: "reference.html",
              kind: "html",
              buffer: Buffer.from("<p>Private fixture content</p>"),
            },
          }),
      formats: ["markdown"],
      timeout: 5000,
    },
  });
  const res = Object.assign(new EventEmitter(), {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  });
  return { res, promise: controllers[endpoint](req as any, res as any) };
}

beforeEach(() => {
  vi.resetAllMocks();
  config.KEYLESS_FEEDBACK_ENABLED = false;
  mocks.requestLog.mockResolvedValue(undefined);
  mocks.scrapeLog.mockResolvedValue(undefined);
  mocks.semaphore.mockImplementation(
    async (_team, _id, _limit, _signal, _timeout, run) => run(false),
  );
  mocks.worker.mockResolvedValue({
    markdown: "Returned text",
    metadata: { statusCode: 200 },
  });
});
afterAll(() => {
  config.KEYLESS_FEEDBACK_ENABLED = originalEnabled;
});

it.each(["scrape", "parse"] as const)(
  "logs a %s failure before worker execution after its parent request",
  async endpoint => {
    let release!: () => void;
    mocks.requestLog.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    mocks.semaphore.mockRejectedValueOnce(
      new TransportableError(
        "CONCURRENCY_QUEUE_TIMEOUT",
        "Concurrency wait timed out",
      ),
    );
    const { res, promise } = start(endpoint);
    await vi.waitFor(() => expect(mocks.semaphore).toHaveBeenCalled());
    expect(mocks.scrapeLog).not.toHaveBeenCalled();
    release();
    await promise;
    expect(res.status).toHaveBeenCalledWith(408);
    const jobId = res.json.mock.calls[0][0].metadata.jobId;
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.scrapeLog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: jobId,
        request_id: jobId,
        team_id: teamId,
        is_successful: false,
        credits_cost: 0,
        ...(endpoint === "parse" ? { is_parse: true } : {}),
      }),
      true,
    );
    expect(mocks.scrapeLog.mock.calls[0][0].options).not.toHaveProperty("file");
    expect(JSON.stringify(mocks.scrapeLog.mock.calls)).not.toContain(
      "Private fixture content",
    );
  },
);

it.each(["scrape", "parse"] as const)(
  "leaves %s worker failure logging with the worker",
  async endpoint => {
    mocks.worker.mockRejectedValueOnce(
      new TransportableError("SCRAPE_TIMEOUT", "Worker timed out"),
    );
    const { res, promise } = start(endpoint);
    await promise;
    expect(res.status).toHaveBeenCalledWith(408);
    expect(res.json.mock.calls[0][0].metadata.jobId).toEqual(
      expect.any(String),
    );
    expect(mocks.scrapeLog).not.toHaveBeenCalled();
  },
);

it.each(["scrape", "parse"] as const)(
  "preserves successful %s references when invitations are disabled",
  async endpoint => {
    const { res, promise } = start(endpoint);
    await promise;
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data.metadata.jobId).toBe(
      mocks.worker.mock.calls[0][0].id,
    );
    expect(res.json.mock.calls[0][0].data.metadata.feedback).toBeUndefined();
    expect(mocks.scrapeLog).not.toHaveBeenCalled();
  },
);

it.each(["scrape", "parse"] as const)(
  "does not change authenticated %s failure logging",
  async endpoint => {
    mocks.semaphore.mockRejectedValueOnce(
      new TransportableError("CONCURRENCY_QUEUE_TIMEOUT"),
    );
    const { res, promise } = start(
      endpoint,
      "7b58279f-94df-4ffb-ad02-e71b793b4b14",
    );
    await promise;
    expect(res.status).toHaveBeenCalledWith(408);
    expect(res.json.mock.calls[0][0].metadata).toBeUndefined();
    expect(mocks.scrapeLog).not.toHaveBeenCalled();
  },
);
