const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  clear: vi.fn(),
  sync: vi.fn(),
  previous: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("../../../lib/logger", () => ({
  logger: {
    info: mocks.audit,
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));
vi.mock("../../../lib/zdr-helpers", () => ({
  getThreatProtection: () => "allowed",
}));
vi.mock("../../../lib/threat-protection/request", () => ({
  THREAT_PROTECTION_CANNOT_TURN_OFF_MESSAGE: "forced",
}));
vi.mock("../../../lib/threat-protection/store", () => ({
  getOrgThreatProtectionConfig: mocks.previous,
  upsertOrgThreatProtectionConfig: mocks.upsert,
  resolveEffectivePolicy: (config: any) => config.policy,
  ZscalerSecretRequiredError: class extends Error {},
}));
vi.mock("../../../lib/threat-protection/providers/zscaler/client", () => ({}));
vi.mock(
  "../../../lib/threat-protection/providers/zscaler/lookup-queue",
  () => ({}),
);
vi.mock("../../../lib/threat-protection/providers/zscaler/sync", () => ({
  clearZscalerSyncState: mocks.clear,
  syncOrgZscalerRules: mocks.sync,
  getZscalerSyncDocument: async () => null,
}));
import { putTeamThreatProtectionController } from "../team-threat-protection";
function run() {
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const pending = putTeamThreatProtectionController(
    { auth: { team_id: "team", org_id: "org" }, body: { mode: "off" } } as any,
    res as any,
  );
  return { res, pending };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.previous.mockResolvedValue({
    policy: { mode: "off" },
    zscaler: { clientId: "old" },
  });
  mocks.upsert.mockResolvedValue({
    policy: { mode: "off" },
    zscaler: { clientId: "new" },
  });
});
it("clears old state before syncing the replacement", async () => {
  const order: string[] = [];
  mocks.clear.mockImplementation(async () => {
    order.push("clear");
  });
  mocks.sync.mockImplementation(async () => {
    order.push("sync");
  });
  const { pending, res } = run();
  await pending;
  expect(order).toEqual(["clear", "sync"]);
  expect(res.status).toHaveBeenCalledWith(200);
});
it("still syncs after clear rejection and preserves its original error", async () => {
  const error = new Error("Redis DEL failed");
  mocks.clear.mockRejectedValue(error);
  const { pending, res } = run();
  await expect(pending).rejects.toBe(error);
  expect(mocks.sync).toHaveBeenCalledWith("org");
  expect(mocks.audit).toHaveBeenCalledWith(
    "Threat protection config updated",
    expect.objectContaining({ orgId: "org" }),
  );
  expect(res.json).not.toHaveBeenCalled();
});
it("retains clear and replacement failures", async () => {
  const clear = new Error("Redis DEL failed"),
    sync = new Error("replacement failed");
  mocks.clear.mockRejectedValue(clear);
  mocks.sync.mockRejectedValue(sync);
  await expect(run().pending).rejects.toMatchObject({ errors: [clear, sync] });
  expect(mocks.audit).toHaveBeenCalledOnce();
});
