import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ forward: vi.fn(), execute: vi.fn() }));

vi.mock("../db/connection", () => ({ db: { execute: mocks.execute } }));
import { authorizeExchangeProviders } from "./exchange-provider-access";
const terms = { key: "particle", version: "v1", digest: "a".repeat(64) };
const input = {
  teamId: "team-a",
  body: { provider: "particle" },
  requirements: mocks.forward,
};
const accepted = {
  org_id: "org-a",
  data_source_id: "particle",
  status: "enabled",
  terms_key: "particle",
  terms_version: "v1",
  terms_accepted_at: "2026-09-10",
  settings: { terms_digest: terms.digest },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.forward.mockResolvedValue({
    status: 200,
    body: { providers: [{ provider: "particle", required: true, terms }] },
  });
  mocks.execute.mockResolvedValue({ rows: [accepted] });
});
it("allows a current enabled acceptance and requests authoritative requirements", async () => {
  expect(await authorizeExchangeProviders(input)).toBeUndefined();
  expect(mocks.forward).toHaveBeenCalledWith(["particle"]);
  expect(mocks.execute).toHaveBeenCalledOnce();
});
it.each([
  {
    ...accepted,
    data_source_id: null,
    terms_version: null,
    terms_accepted_at: null,
  },
  { ...accepted, status: "disabled" },
  { ...accepted, status: "suspended" },
  { ...accepted, terms_version: "old" },
  { ...accepted, settings: { terms_digest: "b".repeat(64) } },
  { ...accepted, terms_accepted_at: null },
])(
  "refuses missing, disabled, suspended or outdated acceptance %#",
  async row => {
    mocks.execute.mockResolvedValue({ rows: [row] });
    expect((await authorizeExchangeProviders(input))?.status).toBe(403);
  },
);
it("refuses the whole batch when any provider lacks acceptance", async () => {
  mocks.forward.mockResolvedValue({
    status: 200,
    body: {
      providers: [
        { provider: "particle", required: true, terms },
        {
          provider: "second",
          required: true,
          terms: { ...terms, key: "second" },
        },
      ],
    },
  });
  expect(
    (
      await authorizeExchangeProviders({
        ...input,
        body: { requests: [{ provider: "particle" }, { provider: "second" }] },
      })
    )?.status,
  ).toBe(403);
});
it.each([
  { providers: [] },
  { providers: [{ provider: "different", required: false, terms: null }] },
  { providers: [{ provider: "particle", required: true, terms: null }] },
  {
    providers: [
      {
        provider: "particle",
        required: true,
        terms: { key: "particle", version: "v1" },
      },
    ],
  },
])(
  "fails closed for incomplete or mismatched requirement metadata %#",
  async body => {
    mocks.forward.mockResolvedValue({ status: 200, body });
    expect((await authorizeExchangeProviders(input))?.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
it("fails closed on database errors", async () => {
  mocks.execute.mockRejectedValue(new Error("database unavailable"));
  expect((await authorizeExchangeProviders(input))?.status).toBe(503);
});
it("allows an enabled provider with no agreement", async () => {
  mocks.forward.mockResolvedValue({
    status: 200,
    body: {
      providers: [{ provider: "particle", required: false, terms: null }],
    },
  });
  expect(await authorizeExchangeProviders(input)).toBeUndefined();
  expect(mocks.execute).toHaveBeenCalledOnce();
});
it("still honors disabled access when agreement acceptance is optional", async () => {
  mocks.forward.mockResolvedValue({
    status: 200,
    body: { providers: [{ provider: "particle", required: false, terms }] },
  });
  mocks.execute.mockResolvedValue({
    rows: [{ ...accepted, status: "disabled" }],
  });
  expect((await authorizeExchangeProviders(input))?.status).toBe(403);
});
it("honors disablement even after a provider document is removed", async () => {
  mocks.forward.mockResolvedValue({
    status: 200,
    body: {
      providers: [{ provider: "particle", required: false, terms: null }],
    },
  });
  mocks.execute.mockResolvedValue({
    rows: [{ ...accepted, status: "disabled" }],
  });
  expect((await authorizeExchangeProviders(input))?.status).toBe(403);
});
it.each([
  null,
  {},
  { provider: "" },
  { requests: [] },
  { requests: "invalid" },
  { requests: Array.from({ length: 11 }, () => ({ provider: "particle" })) },
])("refuses malformed requests before lookup %#", async body => {
  expect((await authorizeExchangeProviders({ ...input, body }))?.status).toBe(
    400,
  );
  expect(mocks.forward).not.toHaveBeenCalled();
});
it("deduplicates provider lookup for a valid batch", async () => {
  await authorizeExchangeProviders({
    ...input,
    body: { requests: [{ provider: "particle" }, { provider: "particle" }] },
  });
  expect(mocks.forward).toHaveBeenCalledWith(["particle"]);
});
