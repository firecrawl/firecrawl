const { setSpanAttributes } = vi.hoisted(() => ({
  setSpanAttributes: vi.fn(),
}));

vi.mock("./otel-tracer", () => ({
  setSpanAttributes,
  withSpan: vi.fn(async (_name, run) => run({})),
}));

vi.mock("../config", () => ({
  config: {
    GCS_BUCKET_NAME: undefined,
    GCS_CREDENTIALS: undefined,
    KEYLESS_CONVERSION_HMAC_SECRET: "a".repeat(32),
  },
}));

import { saveScrapeToGCS } from "./gcs-jobs";

const rawTeamId = "preview_keyless_203.0.113.8";
const pseudonym = "preview_keyless_hmac_v1_bcd8d32706120436adde0e52";

it("pseudonymizes a keyless team before adding it to a GCS span", async () => {
  const logger: any = {
    child: vi.fn(() => logger),
  };

  await saveScrapeToGCS(
    {
      id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
      request_id: "019e6f45-7778-727d-adf0-0abe9d5062b6",
      team_id: rawTeamId,
      is_successful: true,
      zeroDataRetention: false,
    } as any,
    logger,
  );

  expect(setSpanAttributes).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ "job.team_id": pseudonym }),
  );
  expect(JSON.stringify(setSpanAttributes.mock.calls)).not.toContain(rawTeamId);
});
