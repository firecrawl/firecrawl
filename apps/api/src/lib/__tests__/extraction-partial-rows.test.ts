import { describe, expect, it } from "vitest";
import { mergeNullValObjs } from "../extract/helpers/merge-null-val-objs";
import { mergeNullValObjs_F0 } from "../extract/fire-0/helpers/merge-null-val-objs-f0";

for (const merge of [mergeNullValObjs, mergeNullValObjs_F0]) {
  describe(merge.name, () => {
    it("combines JSON rows with a shared identity and omitted complementary fields", () => {
      const rows = JSON.parse('[{"id":"same","email":"a@example.test"},{"id":"same","phone":"123"}]');
      expect(merge({ rows })).toEqual({ rows: [{ id: "same", email: "a@example.test", phone: "123" }] });
    });
    it("keeps conflicting shared values separate", () => {
      const rows = [{ id: "same", label: "first" }, { id: "same", label: "second" }];
      expect(merge({ rows })).toEqual({ rows });
    });
    it("keeps rows with no shared value separate", () => {
      const rows = [{ email: "a@example.test" }, { phone: "123" }];
      expect(merge({ rows })).toEqual({ rows });
    });
    it("retains explicit null filling and array union", () => {
      expect(merge({ rows: [{ id: "same", label: null, tags: [1] }, { id: "same", label: "ok", tags: [2] }] })).toEqual({ rows: [{ id: "same", label: "ok", tags: [1, 2] }] });
    });
  });
}
