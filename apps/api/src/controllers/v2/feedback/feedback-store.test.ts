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
vi.mock("../../../lib/job-store-fallback", () => ({
  recordJobStorePostgresFallback: vi.fn(),
}));

import { lookupFeedbackJob } from "./feedback-store";

const jobId = "d87f3a06-dfef-4a4d-9965-75cba229b983";
const teamId = "9cd10f91-9604-4cd4-85ec-96e7823a4d03";
const row = {
  id: jobId,
  request_id: jobId,
  team_id: teamId,
  credits_cost: 0,
  created_at: new Date().toISOString(),
  options: { formats: ["markdown"] },
  is_successful: true,
};

function selectRows(rows: (typeof row)[]) {
  return {
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readCompactJob.mockResolvedValue(null);
  mocks.primarySelect.mockReturnValue(selectRows([row]));
  mocks.replicaSelect.mockReturnValue(selectRows([]));
});

it("reads the primary for new keyless jobs", async () => {
  const found = await lookupFeedbackJob("scrape", jobId, teamId, {
    requireOptions: true,
  });
  expect(found?.id).toBe(jobId);
  expect(found?.options).toEqual({ formats: ["markdown"] });
  expect(mocks.primarySelect).toHaveBeenCalledOnce();
  expect(mocks.replicaSelect).not.toHaveBeenCalled();
  expect(mocks.readCompactJob).not.toHaveBeenCalled();
});

it("preserves the authenticated lookup path", async () => {
  expect(await lookupFeedbackJob("scrape", jobId, teamId)).toBeNull();
  expect(mocks.readCompactJob).toHaveBeenCalledWith(jobId);
  expect(mocks.replicaSelect).toHaveBeenCalledOnce();
  expect(mocks.primarySelect).not.toHaveBeenCalled();
});
