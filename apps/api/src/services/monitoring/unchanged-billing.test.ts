import { unchangedPagesFreeForInterval } from "./unchanged-billing";

describe("unchangedPagesFreeForInterval", () => {
  const MINUTE = 60 * 1000;

  it("qualifies schedules at or slower than the threshold", () => {
    expect(unchangedPagesFreeForInterval(60 * MINUTE, 60)).toBe(true);
    expect(unchangedPagesFreeForInterval(24 * 60 * MINUTE, 60)).toBe(true);
    expect(unchangedPagesFreeForInterval(15 * MINUTE, 15)).toBe(true);
    expect(unchangedPagesFreeForInterval(24 * 60 * MINUTE, 1440)).toBe(true);
  });

  it("rejects schedules faster than the threshold", () => {
    expect(unchangedPagesFreeForInterval(30 * MINUTE, 60)).toBe(false);
    expect(unchangedPagesFreeForInterval(5 * MINUTE, 15)).toBe(false);
    expect(unchangedPagesFreeForInterval(60 * MINUTE, 1440)).toBe(false);
  });
});
