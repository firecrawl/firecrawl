import { chInsert } from "./clickhouse-client";
import { AGENT_HINT_IDS } from "./agent-hints";
import { trackAgentHints } from "./tracking";

vi.mock("./clickhouse-client", () => ({
  chInsert: vi.fn(),
}));

const base = {
  endpoint: "search",
  jobId: "job-1",
  teamId: "team-1",
  zeroDataRetention: false,
  emittedAt: new Date("2026-01-02T03:04:05.678Z"),
};

describe("agent hint emission tracking", () => {
  beforeEach(() => {
    vi.mocked(chInsert).mockClear();
  });

  it("writes one row per hint with the id, job, team and time", async () => {
    await trackAgentHints({
      ...base,
      hintIds: [
        AGENT_HINT_IDS.LOW_CREDITS,
        AGENT_HINT_IDS.SEARCH_NO_WEB_RESULTS,
      ],
    });

    expect(chInsert).toHaveBeenCalledWith("agent_hint_emissions", [
      {
        hint_id: "low_credits",
        endpoint: "search",
        job_id: "job-1",
        team_id: "team-1",
        emitted_at: "2026-01-02T03:04:05.678Z",
      },
      {
        hint_id: "search_no_web_results",
        endpoint: "search",
        job_id: "job-1",
        team_id: "team-1",
        emitted_at: "2026-01-02T03:04:05.678Z",
      },
    ]);
  });

  it("records no hint text, only the rule id", async () => {
    await trackAgentHints({
      ...base,
      hintIds: [AGENT_HINT_IDS.SCRAPE_SOURCE_GONE],
    });

    const [, rows] = vi.mocked(chInsert).mock.calls[0];
    expect(Object.keys(rows[0]).sort()).toEqual([
      "emitted_at",
      "endpoint",
      "hint_id",
      "job_id",
      "team_id",
    ]);
  });

  it("stores an empty job id when the response carries none", async () => {
    await trackAgentHints({
      ...base,
      jobId: null,
      hintIds: [AGENT_HINT_IDS.LOW_CREDITS],
    });

    const [, rows] = vi.mocked(chInsert).mock.calls[0];
    expect(rows[0].job_id).toBe("");
  });

  it("writes nothing for a zero-data-retention request", async () => {
    await trackAgentHints({
      ...base,
      zeroDataRetention: true,
      hintIds: [AGENT_HINT_IDS.LOW_CREDITS],
    });

    expect(chInsert).not.toHaveBeenCalled();
  });

  it("writes nothing when no hint fired", async () => {
    await trackAgentHints({ ...base, hintIds: [] });

    expect(chInsert).not.toHaveBeenCalled();
  });
});
