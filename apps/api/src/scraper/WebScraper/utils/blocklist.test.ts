import type { TeamFlags } from "../../../controllers/v1/types";
import {
  hasOrgScopedBlocklist,
  initializeBlocklist,
  isUrlBlocked,
} from "./blocklist";

const dbState = vi.hoisted(() => ({
  rows: [] as { data: unknown; org_id: string | null }[],
}));

vi.mock("../../../config", () => ({
  config: {
    USE_DB_AUTHENTICATION: true,
    DISABLE_BLOCKLIST: false,
  },
}));

vi.mock("../../../db/connection", () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(async () => {}) })),
  },
  dbRr: {
    select: vi.fn(() => ({
      from: vi.fn(async () => dbState.rows),
    })),
  },
}));

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const TEAM = "00000000-0000-0000-0000-000000000001";

// NOTE: the matcher also blocks other TLDs of the same base domain, so
// placeholder domains here must not share a base name across lists unless
// the test is exercising exactly that rule.
const GLOBAL_ROW = {
  org_id: null,
  data: {
    blocklist: ["facebook.com"],
    allowedKeywords: ["/legal"],
  },
};

function ctx(org_id: string | null) {
  return { team_id: TEAM, org_id, origin: "test" };
}

describe("isUrlBlocked", () => {
  describe("global entries", () => {
    beforeAll(async () => {
      dbState.rows = [GLOBAL_ROW];
      await initializeBlocklist();
    });

    it("blocks a global entry with no context", () => {
      expect(isUrlBlocked("https://facebook.com/profile", null)).toBe(true);
    });

    it("blocks a global entry for any org", () => {
      expect(
        isUrlBlocked("https://facebook.com/profile", null, ctx(ORG_A)),
      ).toBe(true);
      expect(
        isUrlBlocked("https://facebook.com/profile", null, ctx(null)),
      ).toBe(true);
    });

    it("does not block unlisted domains", () => {
      expect(isUrlBlocked("https://example.com", null, ctx(ORG_A))).toBe(false);
    });

    it("respects global allowedKeywords", () => {
      expect(isUrlBlocked("https://facebook.com/legal", null)).toBe(false);
    });

    it("unblocks a global entry via flags.unblockedDomains", () => {
      const flags = { unblockedDomains: ["facebook.com"] } as TeamFlags;
      expect(isUrlBlocked("https://facebook.com/profile", flags)).toBe(false);
    });
  });

  describe("org-scoped entries", () => {
    beforeAll(async () => {
      dbState.rows = [
        GLOBAL_ROW,
        {
          org_id: ORG_A,
          data: {
            blocklist: ["example.com", "org-blocked.com"],
            allowedKeywords: ["/allowed-path"],
          },
        },
      ];
      await initializeBlocklist();
    });

    it("blocks the org's entry for that org only", () => {
      expect(isUrlBlocked("https://example.com", null, ctx(ORG_A))).toBe(true);
      expect(isUrlBlocked("https://example.com", null, ctx(ORG_B))).toBe(false);
      expect(isUrlBlocked("https://example.com", null, ctx(null))).toBe(false);
      expect(isUrlBlocked("https://example.com", null)).toBe(false);
    });

    it("keeps blocking global entries for the org", () => {
      expect(
        isUrlBlocked("https://facebook.com/profile", null, ctx(ORG_A)),
      ).toBe(true);
    });

    it("blocks subdomains of an org-scoped entry", () => {
      expect(
        isUrlBlocked("https://sub.example.com/page", null, ctx(ORG_A)),
      ).toBe(true);
    });

    it("blocks different TLDs of an org-scoped entry", () => {
      expect(isUrlBlocked("https://example.de", null, ctx(ORG_A))).toBe(true);
    });

    it("unblocks org-scoped entries via flags.unblockedDomains", () => {
      const flags = { unblockedDomains: ["example.com"] } as TeamFlags;
      expect(isUrlBlocked("https://example.com", flags, ctx(ORG_A))).toBe(
        false,
      );
      // Only the listed domain is unblocked, not the org's other entries.
      expect(isUrlBlocked("https://org-blocked.com", flags, ctx(ORG_A))).toBe(
        true,
      );
    });

    it("respects the org blob's own allowedKeywords for its list only", () => {
      expect(
        isUrlBlocked("https://example.com/allowed-path", null, ctx(ORG_A)),
      ).toBe(false);
      // The org's allowedKeywords do not exempt globally-blocked URLs.
      expect(
        isUrlBlocked("https://facebook.com/allowed-path", null, ctx(ORG_A)),
      ).toBe(true);
    });

    it("reports which orgs have org-scoped entries", () => {
      expect(hasOrgScopedBlocklist(ORG_A)).toBe(true);
      expect(hasOrgScopedBlocklist(ORG_B)).toBe(false);
      expect(hasOrgScopedBlocklist(null)).toBe(false);
      expect(hasOrgScopedBlocklist(undefined)).toBe(false);
    });

    it("does not count an org whose rows hold no blockable entries", async () => {
      dbState.rows = [
        GLOBAL_ROW,
        { org_id: ORG_B, data: { blocklist: [], allowedKeywords: ["/x"] } },
      ];
      await initializeBlocklist();
      expect(hasOrgScopedBlocklist(ORG_B)).toBe(false);
    });

    it("does not count an org whose entries are all blank strings", async () => {
      dbState.rows = [
        GLOBAL_ROW,
        {
          org_id: ORG_B,
          data: { blocklist: ["", "   "], allowedKeywords: [] },
        },
      ];
      await initializeBlocklist();
      expect(hasOrgScopedBlocklist(ORG_B)).toBe(false);
    });
  });

  describe("row loading", () => {
    it("merges multiple rows for the same org", async () => {
      dbState.rows = [
        GLOBAL_ROW,
        {
          org_id: ORG_A,
          data: { blocklist: ["example-one.com"], allowedKeywords: [] },
        },
        {
          org_id: ORG_A,
          data: { blocklist: ["example-two.com"], allowedKeywords: [] },
        },
      ];
      await initializeBlocklist();

      expect(isUrlBlocked("https://example-one.com", null, ctx(ORG_A))).toBe(
        true,
      );
      expect(isUrlBlocked("https://example-two.com", null, ctx(ORG_A))).toBe(
        true,
      );
    });

    it("tolerates malformed org row data without breaking loading", async () => {
      dbState.rows = [
        GLOBAL_ROW,
        { org_id: ORG_A, data: null },
        { org_id: ORG_B, data: { blocklist: "not-an-array" } },
      ];
      await initializeBlocklist();

      expect(isUrlBlocked("https://facebook.com/profile", null)).toBe(true);
      expect(isUrlBlocked("https://example.com", null, ctx(ORG_A))).toBe(false);
      expect(isUrlBlocked("https://example.com", null, ctx(ORG_B))).toBe(false);
    });

    it("throws when the table is empty", async () => {
      dbState.rows = [];
      await expect(initializeBlocklist()).rejects.toThrow(
        "No data returned from database",
      );
    });

    it("throws when rows exist but none is global", async () => {
      dbState.rows = [
        { org_id: ORG_A, data: { blocklist: [], allowedKeywords: [] } },
      ];
      await expect(initializeBlocklist()).rejects.toThrow(
        "No global blocklist row",
      );
    });
  });
});
