const { getRows, mutate } = vi.hoisted(() => ({
  getRows: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("../config", () => ({
  config: { BIGTABLE_CHANGE_TRACKING_TABLE: "change_tracking" },
}));

vi.mock("./bigtable-client", () => ({
  getBigtableTable: vi.fn(async () => ({ getRows, mutate })),
}));

vi.mock("./otel-tracer", () => ({
  withSpan: vi.fn(async (_name: string, fn: (span: unknown) => unknown) =>
    fn({}),
  ),
  setSpanAttributes: vi.fn(),
}));

import {
  changeTrackingDeleteTeam,
  changeTrackingGetLastScrape,
} from "./change-tracking-store";

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

describe("changeTrackingDeleteTeam", () => {
  beforeEach(() => {
    getRows.mockReset();
    mutate.mockReset();
    mutate.mockResolvedValue([]);
  });

  // The team's own prefix, ending one past its last character.
  const prefix = Buffer.from(TEAM_ID, "utf8");
  const prefixEnd = Buffer.from("00000000-0000-4000-8000-000000000002");

  function keyOf(byte: number): Buffer {
    return Buffer.concat([prefix, Buffer.alloc(64, byte)]);
  }

  it("deletes the team's rows batch by batch, resuming after the last key", async () => {
    getRows
      .mockResolvedValueOnce([[{ id: keyOf(0x01) }, { id: keyOf(0xff) }]])
      .mockResolvedValueOnce([[{ id: keyOf(0x80) }]])
      .mockResolvedValueOnce([[]]);

    await expect(changeTrackingDeleteTeam(TEAM_ID)).resolves.toBe(3);

    const requests = getRows.mock.calls.map(([request]) => request);
    expect(requests[0]).toMatchObject({
      ranges: [
        {
          start: { value: prefix, inclusive: true },
          end: { value: prefixEnd, inclusive: false },
        },
      ],
      limit: 1000,
      decode: false,
    });
    expect(requests[1].ranges[0].start).toEqual({
      value: keyOf(0xff),
      inclusive: false,
    });
    expect(requests[2].ranges[0].start).toEqual({
      value: keyOf(0x80),
      inclusive: false,
    });

    // Keys go back exactly as Bigtable returned them, raw bytes included.
    expect(mutate.mock.calls.map(([entries]) => entries)).toEqual([
      [
        { key: keyOf(0x01), method: "delete" },
        { key: keyOf(0xff), method: "delete" },
      ],
      [{ key: keyOf(0x80), method: "delete" }],
    ]);
  });

  it("deletes nothing for a team with no rows", async () => {
    getRows.mockResolvedValueOnce([[]]);

    await expect(changeTrackingDeleteTeam(TEAM_ID)).resolves.toBe(0);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("refuses to delete when the client hands back decoded keys", async () => {
    getRows.mockResolvedValueOnce([[{ id: keyOf(0x01).toString("utf8") }]]);

    await expect(changeTrackingDeleteTeam(TEAM_ID)).rejects.toThrow(
      "decoded row keys",
    );
    expect(mutate).not.toHaveBeenCalled();
  });

  it("stops at a failed delete so the caller retries the pass", async () => {
    getRows.mockResolvedValueOnce([[{ id: keyOf(0x01) }]]);
    mutate.mockRejectedValueOnce(new Error("unavailable"));

    await expect(changeTrackingDeleteTeam(TEAM_ID)).rejects.toThrow(
      "unavailable",
    );
    expect(getRows).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an empty id", ""],
    ["an uppercase id", "0000000A-0000-4000-8000-000000000001"],
    ["a truncated id", TEAM_ID.slice(0, 8)],
    ["a preview team", "preview_127.0.0.1"],
  ])("refuses %s without reading the table", async (_label, teamId) => {
    await expect(changeTrackingDeleteTeam(teamId)).rejects.toThrow(
      "Expected a lowercase team UUID",
    );
    expect(getRows).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});
