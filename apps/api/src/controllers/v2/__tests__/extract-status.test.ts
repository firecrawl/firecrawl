import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getExtract: vi.fn(),
  getExtractExpiry: vi.fn(),
  getExtractResult: vi.fn(),
  getJobFromGCS: vi.fn(),
  supabaseGetAgentByIdDirect: vi.fn(),
  supabaseGetExtractByIdDirect: vi.fn(),
  supabaseGetExtractRequestByIdDirect: vi.fn(),
}));

vi.mock("../../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: false,
    GCS_BUCKET_NAME: undefined,
  },
}));

vi.mock("../../../lib/extract/extract-redis", () => ({
  getExtract: mocks.getExtract,
  getExtractExpiry: mocks.getExtractExpiry,
  getExtractResult: mocks.getExtractResult,
}));

vi.mock("../../../lib/supabase-jobs", () => ({
  supabaseGetAgentByIdDirect: mocks.supabaseGetAgentByIdDirect,
  supabaseGetExtractByIdDirect: mocks.supabaseGetExtractByIdDirect,
  supabaseGetExtractRequestByIdDirect:
    mocks.supabaseGetExtractRequestByIdDirect,
}));

vi.mock("../../../lib/gcs-jobs", () => ({
  getJobFromGCS: mocks.getJobFromGCS,
}));

vi.mock("../../../lib/logger", () => ({ logger: {} }));

import { config } from "../../../config";
import { extractStatusController } from "../extract-status";

function responseMock() {
  const res: any = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

describe("v2 extract status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.USE_DB_AUTHENTICATION = false;
    mocks.getExtract.mockResolvedValue(null);
  });

  it("returns 404 for an unknown self-hosted job instead of dereferencing null", async () => {
    const req: any = {
      params: { jobId: "00000000-0000-4000-8000-000000000001" },
      auth: { team_id: "bypass" },
    };
    const res = responseMock();

    await extractStatusController(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Extract job not found",
    });
    expect(mocks.getExtractExpiry).not.toHaveBeenCalled();
  });

  it("retains the authenticated in-progress fallback for an owned request", async () => {
    config.USE_DB_AUTHENTICATION = true;
    mocks.supabaseGetExtractRequestByIdDirect.mockResolvedValue({
      team_id: "team-a",
      kind: "extract",
      created_at: "2026-08-08T00:00:00.000Z",
    });
    mocks.supabaseGetExtractByIdDirect.mockResolvedValue(null);
    const req: any = {
      params: { jobId: "00000000-0000-4000-8000-000000000002" },
      auth: { team_id: "team-a" },
    };
    const res = responseMock();

    await extractStatusController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, status: "processing" }),
    );
  });
});
