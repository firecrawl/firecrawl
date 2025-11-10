import { extractStatusController } from "../v2/extract-status";
import { getExtract, getExtractExpiry } from "../../lib/extract/extract-redis";
import { getExtractQueue } from "../../services/queue-service";
import { supabaseGetJobByIdDirect } from "../../lib/supabase-jobs";

jest.mock("../../lib/extract/extract-redis", () => ({
  getExtract: jest.fn(),
  getExtractExpiry: jest.fn(),
}));

jest.mock("../../services/queue-service", () => ({
  getExtractQueue: jest.fn().mockReturnValue({
    getJob: jest.fn(),
  }),
}));

jest.mock("../../lib/supabase-jobs", () => ({
  supabaseGetJobByIdDirect: jest.fn(),
}));

const mockGetExtract = getExtract as jest.MockedFunction<typeof getExtract>;
const mockGetExtractExpiry = getExtractExpiry as jest.MockedFunction<
  typeof getExtractExpiry
>;
const mockGetExtractQueue = getExtractQueue as jest.MockedFunction<
  typeof getExtractQueue
>;
const mockSupabaseGetJobByIdDirect =
  supabaseGetJobByIdDirect as jest.MockedFunction<
    typeof supabaseGetJobByIdDirect
  >;

const createMockResponse = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  return res;
};

describe("extractStatusController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns failed status when redis record is marked failed", async () => {
    const extractId = "extract-123";
    const teamId = "team-1";
    const errorMessage = "All provided URLs are invalid.";
    const expiresAt = new Date("2025-01-01T00:00:00.000Z");

    mockGetExtract.mockResolvedValue({
      id: extractId,
      team_id: teamId,
      status: "failed",
      error: errorMessage,
    } as any);
    mockGetExtractExpiry.mockResolvedValue(expiresAt);

    const req = {
      params: { jobId: extractId },
      auth: { team_id: teamId },
    } as any;
    const res = createMockResponse();

    await extractStatusController(req, res as any);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        status: "failed",
        error: errorMessage,
        data: [],
        expiresAt: expiresAt.toISOString(),
      }),
    );
    expect(mockGetExtract).toHaveBeenCalledWith(extractId);
    expect(mockGetExtractExpiry).toHaveBeenCalledWith(extractId);
    expect(mockGetExtractQueue).not.toHaveBeenCalled();
    expect(mockSupabaseGetJobByIdDirect).not.toHaveBeenCalled();
  });
});
