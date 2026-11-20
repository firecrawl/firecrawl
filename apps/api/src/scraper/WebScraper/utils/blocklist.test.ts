import type { TeamFlags } from "../../../controllers/v1/types";
import {
  clearExchangeProvidersForTest,
  setExchangeProvidersForTest,
} from "../../../lib/exchange";
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

function countCollectionEntries<T>(lookup: () => T) {
  const collections = [[], new Set(), new Map()];
  const iterators = collections.map(collection => {
    const prototype = Object.getPrototypeOf(collection[Symbol.iterator]());
    return { prototype, next: prototype.next };
  });
  const callbacks = collections.map(collection => {
    const prototype = Object.getPrototypeOf(collection);
    return { prototype, forEach: prototype.forEach };
  });
  const arrayPrototype = Object.getPrototypeOf([]);
  const searches = ["find", "includes", "some"].map(name => ({
    name,
    method: arrayPrototype[name],
  }));
  let entries = 0;
  try {
    // Count consumed entries, including copies subsequently scanned with find/includes
    // and equality-only loops. String-method call counts miss those linear lookups.
    for (const { prototype, next } of iterators) {
      prototype.next = function (this: Iterator<unknown>) {
        const result = next.call(this) as IteratorResult<unknown>;
        if (!result.done) entries++;
        return result;
      };
    }
    for (const { prototype, forEach } of callbacks) {
      prototype.forEach = function (
        this: unknown,
        callback: (...args: unknown[]) => unknown,
        thisArg?: unknown,
      ) {
        return forEach.call(this, (...args: unknown[]) => {
          entries++;
          return callback.apply(thisArg, args);
        });
      };
    }
    for (const { name, method } of searches) {
      arrayPrototype[name] = function (this: unknown[], ...args: unknown[]) {
        // Native array searches bypass iterators, including searches on an array
        // cached at load time. Observe their actual indexed reads instead.
        const measured = new Proxy(this, {
          get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key)) entries++;
            return Reflect.get(target, key, receiver);
          },
        });
        return method.apply(measured, args);
      };
    }
    entries = 0;
    const result = lookup();
    return { result, entries };
  } finally {
    for (const { prototype, next } of iterators) prototype.next = next;
    for (const { prototype, forEach } of callbacks) prototype.forEach = forEach;
    for (const { name, method } of searches) arrayPrototype[name] = method;
  }
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

  describe("allowed keywords on URLs the Exchange claims", () => {
    beforeAll(async () => {
      dbState.rows = [
        {
          org_id: null,
          data: {
            blocklist: ["example.com"],
            allowedKeywords: ["about", "press"],
          },
        },
      ];
      await initializeBlocklist();
      setExchangeProvidersForTest([
        {
          id: "acme",
          routes: [
            { domains: ["example.com"], pathPrefixes: ["/company/", "/in/"] },
          ],
        },
      ]);
    });

    afterAll(() => {
      clearExchangeProvidersForTest();
    });

    it("keeps blocking a claimed URL that contains an allowed keyword", () => {
      expect(
        isUrlBlocked("https://example.com/company/example-co/about/", null),
      ).toBe(true);
      expect(isUrlBlocked("https://example.com/in/example-presser", null)).toBe(
        true,
      );
    });

    it("still exempts unclaimed URLs that contain an allowed keyword", () => {
      expect(isUrlBlocked("https://example.com/about", null)).toBe(false);
      expect(isUrlBlocked("https://example.com/press/2026", null)).toBe(false);
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

  describe("domain lookup work and exemptions", () => {
    it("does not scan every entry when a URL is absent from a large list", async () => {
      dbState.rows = [
        {
          org_id: null,
          data: {
            blocklist: Array.from(
              { length: 2000 },
              (_, i) => `blocked-${i}.com`,
            ),
            allowedKeywords: [],
          },
        },
      ];
      await initializeBlocklist();

      const { result, entries } = countCollectionEntries(() =>
        isUrlBlocked("https://unlisted.example.org/path", null),
      );

      expect(result).toBe(false);
      expect(entries).toBeLessThan(100);
    });

    it("keeps another TLD blocked when only one entry is exempt", async () => {
      dbState.rows = [
        {
          org_id: null,
          data: {
            blocklist: ["example.com", "example.net"],
            allowedKeywords: [],
          },
        },
      ];
      await initializeBlocklist();

      const oneExempt = { unblockedDomains: ["example.com"] } as TeamFlags;
      expect(isUrlBlocked("https://example.com", oneExempt)).toBe(true);
      expect(isUrlBlocked("https://example.org", oneExempt)).toBe(true);
      const bothExempt = {
        unblockedDomains: ["example.com", "example.net"],
      } as TeamFlags;
      expect(isUrlBlocked("https://example.org", bothExempt)).toBe(false);
    });

    it("preserves suffix matches and the short base-name restriction", async () => {
      dbState.rows = [
        {
          org_id: null,
          data: { blocklist: ["co.uk", "ab.com"], allowedKeywords: [] },
        },
      ];
      await initializeBlocklist();

      expect(isUrlBlocked("https://shop.example.co.uk", null)).toBe(true);
      expect(
        isUrlBlocked("https://shop.example.co.uk", {
          unblockedDomains: ["co.uk"],
        } as TeamFlags),
      ).toBe(false);
      expect(isUrlBlocked("https://ab.com", null)).toBe(true);
      expect(isUrlBlocked("https://ab.net", null)).toBe(false);
    });

    it("replaces global and org lookup data on reload", async () => {
      dbState.rows = [
        GLOBAL_ROW,
        {
          org_id: ORG_A,
          data: { blocklist: ["old-org.example"], allowedKeywords: [] },
        },
      ];
      await initializeBlocklist();
      expect(isUrlBlocked("https://old-org.example", null, ctx(ORG_A))).toBe(
        true,
      );

      dbState.rows = [
        {
          org_id: null,
          data: { blocklist: ["new-global.com"], allowedKeywords: [] },
        },
        {
          org_id: ORG_A,
          data: { blocklist: ["new-org.example"], allowedKeywords: [] },
        },
      ];
      await initializeBlocklist();
      expect(isUrlBlocked("https://facebook.com", null, ctx(ORG_A))).toBe(
        false,
      );
      expect(isUrlBlocked("https://old-org.example", null, ctx(ORG_A))).toBe(
        false,
      );
      expect(isUrlBlocked("https://new-global.com", null, ctx(ORG_A))).toBe(
        true,
      );
      expect(isUrlBlocked("https://new-org.example", null, ctx(ORG_A))).toBe(
        true,
      );
    });
  });
});
