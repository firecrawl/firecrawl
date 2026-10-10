import { describe, expect, it, vi } from "vitest";
vi.mock("../logger", () => ({ logger: { error: vi.fn() } }));
import { SourceTracker } from "../extract/helpers/source-tracker";
import { SourceTracker_F0 } from "../extract/fire-0/helpers/source-tracker-f0";

for (const f0 of [false, true]) {
  describe(f0 ? "F0 primitive sources" : "shared primitive sources", () => {
    const create = () => {
      const tracker = f0 ? new SourceTracker_F0() : new SourceTracker();
      return {
        transform: f0 ? (tracker as SourceTracker_F0).transformResults_F0.bind(tracker) : (tracker as SourceTracker).transformResults.bind(tracker),
        map: f0 ? (tracker as SourceTracker_F0).mapSourcesToFinalItems_F0.bind(tracker) : (tracker as SourceTracker).mapSourcesToFinalItems.bind(tracker),
      };
    };
    for (const value of [42, false, null]) {
      it(`retains the matching source of root array value ${value}`, () => {
        const tracker = create();
        tracker.transform([{ extract: [value], url: "https://a.test" }, { extract: ["other"], url: "https://b.test" }], {}, false);
        expect(tracker.map([value], [])).toEqual({ "[0]": ["https://a.test"] });
      });
    }
    it("retains sources of object-contained numeric arrays", () => {
      const tracker = create();
      tracker.transform([{ extract: { values: [42] }, url: "https://a.test" }, { extract: { values: [7] }, url: "https://b.test" }], { properties: { values: { type: "array", items: { type: "number" } } } }, false);
      expect(tracker.map({ values: [42] }, ["values"])).toEqual({ "values[0]": ["https://a.test"] });
    });
    it("retains object merge source matching", () => {
      const tracker = create();
      tracker.transform([{ extract: [{ id: "same", name: null }], url: "https://a.test" }, { extract: [{ id: "same", name: "resolved" }], url: "https://b.test" }], {}, false);
      expect(tracker.map([{ id: "same", name: "resolved" }], [])).toEqual({ "[0]": ["https://a.test", "https://b.test"] });
    });
  });
}
