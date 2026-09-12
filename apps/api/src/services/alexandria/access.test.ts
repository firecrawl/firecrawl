const mocks = vi.hoisted(() => ({ execute: vi.fn(), request: vi.fn() }));
vi.mock("../../db/connection", () => ({ db: { execute: mocks.execute } }));
vi.mock("./client", () => ({ exchangeRequest: mocks.request }));
import { authorizeProviders } from "./access";
const call = {
  provider: "fred",
  capability: "series/observations",
  options: {},
};
const row = {
  org_id: "org",
  data_source_id: null,
  status: null,
  terms_key: null,
  terms_version: null,
  terms_accepted_at: null,
  settings: null,
};
const terms = { key: "fred", version: "v1", digest: "a".repeat(64) };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ rows: [row] });
  mocks.request.mockResolvedValue({
    status: 200,
    body: { providers: [{ provider: "fred", required: false, terms: null }] },
  });
});
it("allows providers without an agreement unless explicitly disabled", async () => {
  expect(await authorizeProviders("team", [call])).toBeUndefined();
});
it.each(["disabled", "suspended"])(
  "enforces organization %s settings",
  async status => {
    mocks.execute.mockResolvedValue({
      rows: [{ ...row, data_source_id: "fred", status }],
    });
    expect((await authorizeProviders("team", [call]))?.status).toBe(403);
  },
);
it.each(
  [
    [],
    [{ provider: "other", required: false, terms: null }],
    [{ provider: "fred", required: true, terms: null }],
  ].map(providers => ({ providers })),
)(
  "fails closed on incomplete or invalid agreement requirements",
  async ({ providers }) => {
    mocks.request.mockResolvedValue({ status: 200, body: { providers } });
    expect((await authorizeProviders("team", [call]))?.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
it("requires the exact accepted agreement digest and version", async () => {
  mocks.request.mockResolvedValue({
    status: 200,
    body: { providers: [{ provider: "fred", required: true, terms }] },
  });
  expect((await authorizeProviders("team", [call]))?.status).toBe(403);
  mocks.execute.mockResolvedValue({
    rows: [
      {
        ...row,
        data_source_id: "fred",
        status: "enabled",
        terms_key: terms.key,
        terms_version: terms.version,
        terms_accepted_at: "2026-01-01",
        settings: { terms_digest: terms.digest },
      },
    ],
  });
  expect(await authorizeProviders("team", [call])).toBeUndefined();
});
it("does not allow execution if the organization cannot be read", async () => {
  mocks.execute.mockResolvedValue({ rows: [] });
  await expect(authorizeProviders("team", [call])).rejects.toThrow();
});
