import { getExtractV3AgentStatus } from "../extract-v3-status";

vi.mock("../../config", () => ({
  config: {
    EXTRACT_V3_BETA_URL: "https://agent.example",
    AGENT_INTEROP_SECRET: "test-secret",
  },
}));

const success = (body: object) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe("getExtractV3AgentStatus credit reconciliation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads final credits from trace when a completed status omits them", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        success({ id: "job-1", success: true, status: "success" }),
      )
      .mockResolvedValueOnce(success({ success: true, creditsUsed: 9 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getExtractV3AgentStatus("job-1");

    expect(result.creditsUsed).toBe(9);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://agent.example/internal/extracts/job-1/trace",
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer test-secret",
    );
  });

  it("avoids the trace request when credits are already included", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      success({ id: "job-1", success: true, status: "success", creditsUsed: 8 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect((await getExtractV3AgentStatus("job-1")).creditsUsed).toBe(8);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a trace for an in-progress run", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(success({ id: "job-1", success: true, status: "processing" }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await getExtractV3AgentStatus("job-1")).creditsUsed).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps completed data when the trace request fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        success({ id: "job-1", success: true, status: "success", data: { answer: 42 } }),
      )
      .mockRejectedValueOnce(new Error("Trace service unavailable"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getExtractV3AgentStatus("job-1");
    expect(result.data).toEqual({ answer: 42 });
    expect(result.creditsUsed).toBeUndefined();
  });

  it("does not accept an invalid trace credit total", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        success({ id: "job-1", success: true, status: "success" }),
      )
      .mockResolvedValueOnce(success({ success: true, creditsUsed: -1 }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await getExtractV3AgentStatus("job-1")).creditsUsed).toBeUndefined();
  });
});
