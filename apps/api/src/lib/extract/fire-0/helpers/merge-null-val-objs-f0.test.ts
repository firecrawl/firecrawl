import { describe, expect, it, vi } from "vitest";
import { mergeNullValObjs_F0 } from "./merge-null-val-objs-f0";

describe("merging extracted array fields", () => {
  it("keeps the first occurrence, order, and JSON equality of merged values", () => {
    const first = { label: "first", value: 1 };
    const differentKeyOrder = { value: 1, label: "first" };
    const left = [first, null, "", [1, 2], false, 0];
    const right = [
      { label: "first", value: 1 },
      [1, 2],
      null,
      differentKeyOrder,
      "last",
    ];
    const input = {
      records: [
        { id: "same", values: left },
        { id: "same", values: right },
      ],
    };
    const before = JSON.stringify(input);

    const result = mergeNullValObjs_F0(input);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].values).toEqual([
      first,
      null,
      "",
      [1, 2],
      false,
      0,
      differentKeyOrder,
      "last",
    ]);
    expect(result.records[0].values[0]).toBe(first);
    expect(result.records[0].values).not.toBe(left);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does only linear serialization work when combining large array fields", () => {
    const left = Array.from({ length: 200 }, (_, id) => ({ id }));
    const right = Array.from({ length: 200 }, (_, id) => ({ id: id + 100 }));
    const stringify = vi.spyOn(JSON, "stringify");
    let result;
    let serializations;
    try {
      result = mergeNullValObjs_F0({
        records: [
          { id: "same", values: left },
          { id: "same", values: right },
        ],
      });
      serializations = stringify.mock.calls.length;
    } finally {
      stringify.mockRestore();
    }

    expect(result!.records[0].values).toEqual(
      Array.from({ length: 300 }, (_, id) => ({ id })),
    );
    expect(serializations!).toBeLessThanOrEqual(
      2 * (left.length + right.length),
    );
  });
});
