const { getRows } = vi.hoisted(() => ({
  getRows: vi.fn(),
}));

vi.mock("../config", () => ({
  config: { BIGTABLE_CHANGE_TRACKING_TABLE: "change_tracking" },
}));

vi.mock("./bigtable-client", () => ({
  getBigtableTable: vi.fn(async () => ({ getRows })),
}));

vi.mock("./otel-tracer", () => ({
  withSpan: vi.fn(async (_name: string, fn: (span: unknown) => unknown) =>
    fn({}),
  ),
  setSpanAttributes: vi.fn(),
}));

import { changeTrackingGetLastScrape } from "./change-tracking-store";

const TEAM_ID = "00000000-0000-4000-8000-000000000001";
const URL = "https://example.com/a?b=c&d=e";

describe("changeTrackingGetLastScrape", () => {
  beforeEach(() => {
    getRows.mockReset();
  });

  it("returns null when Bigtable has no row for the key", async () => {
    getRows.mockResolvedValueOnce([[]]);

    await expect(
      changeTrackingGetLastScrape({ team_id: TEAM_ID, url: URL, tag: null }),
    ).resolves.toBeNull();
  });

  it("returns null when the row has no job cell", async () => {
    getRows.mockResolvedValueOnce([[{ data: { m: {} } }]]);

    await expect(
      changeTrackingGetLastScrape({ team_id: TEAM_ID, url: URL, tag: null }),
    ).resolves.toBeNull();
  });

  it("returns the job id and the cell timestamp as an ISO date", async () => {
    getRows.mockResolvedValueOnce([
      [
        {
          data: {
            m: {
              job: [
                {
                  value: "0199a5b2-4c1e-7d3a-9b8e-2f6a1c0d4e57",
                  timestamp: "1788294775115000",
                },
              ],
            },
          },
        },
      ],
    ]);

    await expect(
      changeTrackingGetLastScrape({ team_id: TEAM_ID, url: URL, tag: null }),
    ).resolves.toEqual({
      job_id: "0199a5b2-4c1e-7d3a-9b8e-2f6a1c0d4e57",
      date_added: "2026-09-01T20:32:55.115Z",
    });
  });

  // Rows backfilled from the archive were written with these exact keys;
  // changing the layout makes them unreachable.
  it.each([
    [
      "null tag",
      URL,
      null,
      "30303030303030302d303030302d343030302d383030302d3030303030303030303030319a76278d57595f4aa96bb240c74a465afbf0abf221539c17bbbdf466e1227f8a6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    ],
    [
      "empty tag",
      URL,
      "",
      "30303030303030302d303030302d343030302d383030302d3030303030303030303030319a76278d57595f4aa96bb240c74a465afbf0abf221539c17bbbdf466e1227f8a4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a",
    ],
    [
      "ascii tag",
      URL,
      "pricing",
      "30303030303030302d303030302d343030302d383030302d3030303030303030303030319a76278d57595f4aa96bb240c74a465afbf0abf221539c17bbbdf466e1227f8ab072e2d28f075eb45658fef29336b2d7f89821023553c893a72ad837ce69ee5e",
    ],
    [
      "non-ascii tag",
      "https://example.com/a",
      "árlista-ü",
      "30303030303030302d303030302d343030302d383030302d3030303030303030303030312dce0a4c50441bfccfa9caf4b58c3cba6e06c420505dd829f0436de1aa44baacd7ab7db259424772cc9d7ba7be19af8dfd04413109189162f747e6859608654e",
    ],
  ])("reads the row key layout for a %s", async (_label, url, tag, keyHex) => {
    getRows.mockResolvedValueOnce([[]]);

    await changeTrackingGetLastScrape({ team_id: TEAM_ID, url, tag });

    const [request] = getRows.mock.calls[0];
    expect(Buffer.from(request.keys[0]).toString("hex")).toBe(keyHex);
    expect(request.filter).toEqual([{ column: { name: "job", cellLimit: 1 } }]);
  });
});
