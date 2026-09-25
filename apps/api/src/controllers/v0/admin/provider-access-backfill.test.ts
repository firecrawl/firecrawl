const mocks = vi.hoisted(() => ({ backfill: vi.fn() }));
vi.mock("../../../services/alexandria/access-backfill", () => ({
  backfillProviderAccess: mocks.backfill,
}));
import { providerAccessBackfillController } from "./provider-access-backfill";

const orgId = "4f6c0f0e-6a1f-4c8e-9a53-2b1f1f0e7a11";
const call = async (body: unknown) => {
  const res: any = { status: vi.fn(() => res), json: vi.fn(() => res) };
  await providerAccessBackfillController({ body } as any, res);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.backfill.mockImplementation(async ({ dryRun }) => ({
    dryRun,
    results: [
      { orgId, provider: "benzinga", outcome: "would_write", action: "insert" },
    ],
  }));
});

it("is a dry run unless the body says otherwise", async () => {
  const res = await call({ orgIds: [orgId] });
  expect(mocks.backfill).toHaveBeenCalledWith({
    orgIds: [orgId],
    dryRun: true,
  });
  expect(res.json).toHaveBeenCalledWith(
    expect.objectContaining({ dryRun: true, counts: { would_write: 1 } }),
  );
  await call({ orgIds: [orgId], dryRun: false });
  expect(mocks.backfill).toHaveBeenLastCalledWith({
    orgIds: [orgId],
    dryRun: false,
  });
});

it.each([
  {},
  { orgIds: [] },
  { orgIds: ["not-a-uuid"] },
  { orgIds: [orgId], dryRun: "no" },
  { orgIds: [orgId], extra: 1 },
])("refuses %j without running", async body => {
  const res = await call(body);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(mocks.backfill).not.toHaveBeenCalled();
});
