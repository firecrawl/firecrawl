import { callSchema } from "./contracts";

const call = { provider: "example", capability: "search", options: {} };
it("keeps version optional and accepts exact releases", () => {
  expect(callSchema.parse(call)).toEqual(call);
  expect(callSchema.parse({ ...call, version: "1.2.3" }).version).toBe("1.2.3");
});
it.each(["", "latest", "^1.0.0", 123, null])(
  "rejects invalid version %s",
  version => {
    expect(callSchema.safeParse({ ...call, version }).success).toBe(false);
  },
);
