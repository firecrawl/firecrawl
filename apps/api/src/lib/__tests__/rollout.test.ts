import { describe, expect, it } from "vitest";
import { sampled } from "../rollout";

const orgs = Array.from({ length: 2000 }, (_, i) => `org-${i}`);

describe("sampled", () => {
  it("is off at 0 and on at 100", () => {
    expect(orgs.some(o => sampled(o, 0))).toBe(false);
    expect(orgs.every(o => sampled(o, 100))).toBe(true);
  });

  it("only ever adds as the percentage rises", () => {
    // The property the whole ramp rests on: nobody is moved back off firebill
    // by a later step, so each stage is a superset of the one before it.
    const stages = [5, 10, 30, 60, 80, 100];
    for (const org of orgs) {
      let wasIn = false;
      for (const percent of stages) {
        const isIn = sampled(org, percent);
        expect(!wasIn || isIn).toBe(true);
        wasIn = isIn;
      }
    }
  });

  it("gives the same answer every call", () => {
    for (const org of orgs.slice(0, 50)) {
      const first = sampled(org, 37);
      for (let i = 0; i < 5; i++) expect(sampled(org, 37)).toBe(first);
    }
  });

  it("lands near the requested share", () => {
    for (const percent of [5, 30, 60]) {
      const hits = orgs.filter(o => sampled(o, percent)).length;
      const share = (hits / orgs.length) * 100;
      expect(Math.abs(share - percent)).toBeLessThan(5);
    }
  });
});
