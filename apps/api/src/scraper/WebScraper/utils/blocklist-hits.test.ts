import { keylessTeamId, keylessTeamUuid } from "../../../lib/keyless-team";
import { logger } from "../../../lib/logger";
import { initializeBlocklist, isUrlBlocked } from "./blocklist";

const insertedHits = vi.hoisted(() =>
  vi.fn(
    async (
      _hits: { team_id: string | null; url: string | null; domain: string }[],
    ) => {},
  ),
);

vi.mock("../../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
    DISABLE_BLOCKLIST: false,
  },
}));

vi.mock("../../../db/connection", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertedHits })),
  },
  dbRr: {
    select: vi.fn(() => ({
      from: vi.fn(async () => [
        {
          org_id: null,
          data: { blocklist: ["facebook.com"], allowedKeywords: [] },
        },
      ]),
    })),
  },
}));

beforeEach(async () => {
  vi.useFakeTimers();
  insertedHits.mockClear();
  await initializeBlocklist();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const recordHits = async (teamIds: (string | null)[]) => {
  for (const team_id of teamIds)
    expect(
      isUrlBlocked("https://facebook.com/page", null, {
        team_id,
        origin: "test",
      }),
    ).toBe(true);
  await vi.advanceTimersByTimeAsync(5000);
};

it("stores every hit in a batch under a UUID team id or null", async () => {
  const team = "5f0c2b1e-8d4a-4c3b-9e2f-1a2b3c4d5e6f";
  const keyless = keylessTeamId("203.0.113.7");

  await recordHits([team, keyless, "preview", "not-a-uuid", null]);

  // One batch carries every hit, so each team id must be a UUID or null.
  expect(insertedHits).toHaveBeenCalledOnce();
  expect(insertedHits.mock.calls[0][0].map(hit => hit.team_id)).toEqual([
    team,
    keylessTeamUuid(keyless),
    "3adefd26-77ec-5968-8dcf-c94b5630d1de",
    null,
    null,
  ]);
});

it("logs a failed batch with only its SQLSTATE", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
  insertedHits.mockRejectedValueOnce(
    Object.assign(new Error("https://facebook.com/page"), { code: "22P02" }),
  );

  await recordHits([null, null]);

  expect(warn).toHaveBeenCalledWith("Failed to record blocklist hits", {
    hits: 2,
    errorCode: "22P02",
  });
});

it("records no hit for zero data retention requests", async () => {
  const url = "https://facebook.com/page";

  isUrlBlocked(url, null, { origin: "test" });
  isUrlBlocked(url, null, { origin: "test", zeroDataRetention: true });
  isUrlBlocked(url, { scrapeZDR: "forced" }, { origin: "test" });
  isUrlBlocked(url, { forceZDR: true }, { origin: "test" });
  isUrlBlocked(url, { scrapeZDR: "allowed" }, { origin: "test" });
  await vi.advanceTimersByTimeAsync(5000);

  expect(insertedHits).toHaveBeenCalledOnce();
  expect(
    insertedHits.mock.calls[0][0].map(hit => [hit.url, hit.domain]),
  ).toEqual([
    [url, "facebook.com"],
    [url, "facebook.com"],
  ]);
});
