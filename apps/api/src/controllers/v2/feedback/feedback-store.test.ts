const mocks = vi.hoisted(() => ({
  primarySelect: vi.fn(),
  replicaSelect: vi.fn(),
  readCompactJob: vi.fn(),
}));

vi.mock("../../../db/connection", () => ({
  db: { select: mocks.primarySelect },
  dbRr: { select: mocks.replicaSelect },
}));
vi.mock("../../../lib/feedback-job-store", () => ({
  readFeedbackJob: mocks.readCompactJob,
}));

import { lookupFeedbackJob } from "./feedback-store";

const jobId = "d87f3a06-dfef-4a4d-9965-75cba229b983";
const teamId = "9cd10f91-9604-4cd4-85ec-96e7823a4d03";
const createdAtMs = Date.now() - 3600000;
const job = {
  requestId: jobId,
  teamId,
  refundClass: "scrape_basic",
  feedbackDeadlineMs: createdAtMs + 120000,
  succeeded: true,
  creditsBilled: 0,
  zeroDataRetention: false,
  keyless: { createdAtMs, options: { formats: ["markdown"] } },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readCompactJob.mockResolvedValue(job);
});

afterEach(() => {
  expect(mocks.primarySelect).not.toHaveBeenCalled();
  expect(mocks.replicaSelect).not.toHaveBeenCalled();
});

it("reads keyless context after the authenticated deadline without PostgreSQL", async () => {
  const found = await lookupFeedbackJob("scrape", jobId, teamId, {
    requireOptions: true,
  });
  expect(found).toMatchObject({
    id: jobId,
    options: job.keyless.options,
    created_at: new Date(createdAtMs).toISOString(),
  });
  expect(mocks.readCompactJob).toHaveBeenCalledWith(jobId);
});

it.each([
  { keyless: undefined },
  { teamId: "another-team" },
  { refundClass: "parse" },
  { zeroDataRetention: true },
])("rejects ineligible keyless context: %j", async overrides => {
  mocks.readCompactJob.mockResolvedValue({ ...job, ...overrides });
  expect(
    await lookupFeedbackJob("scrape", jobId, teamId, { requireOptions: true }),
  ).toBeNull();
});

it("preserves authenticated feedback for older records without keyless context", async () => {
  mocks.readCompactJob.mockResolvedValue({ ...job, keyless: undefined });
  expect(await lookupFeedbackJob("scrape", jobId, teamId)).toMatchObject({
    id: jobId,
    options: null,
    feedback_deadline_ms: job.feedbackDeadlineMs,
  });
});

it("does not fall back to PostgreSQL on a Bigtable miss", async () => {
  mocks.readCompactJob.mockResolvedValueOnce(null);
  expect(
    await lookupFeedbackJob("scrape", jobId, teamId, { requireOptions: true }),
  ).toBeNull();
});

it("keeps a keyless lookup retryable when Bigtable is unavailable", async () => {
  const outage = new Error("Unavailable");
  mocks.readCompactJob.mockRejectedValueOnce(outage);
  await expect(
    lookupFeedbackJob("scrape", jobId, teamId, { requireOptions: true }),
  ).rejects.toBe(outage);
});

it("keeps authenticated lookups unchanged when Bigtable is unavailable", async () => {
  mocks.readCompactJob.mockRejectedValueOnce(new Error("Unavailable"));
  expect(await lookupFeedbackJob("scrape", jobId, teamId)).toBeNull();
});
