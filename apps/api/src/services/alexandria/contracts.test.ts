import { callSchema } from "./contracts";

const call = { provider: "example", capability: "search", options: {} };
it("keeps version optional and accepts exact releases", () => {
  expect(callSchema.parse(call)).toEqual(call);
  expect(callSchema.parse({ ...call, version: "1.2.3" }).version).toBe("1.2.3");
});
it.each([
  "",
  "latest",
  "^1.0.0",
  123,
  null,
  "01.2.3",
  "1.2.3-alpha..1",
  "1.2.3-01",
  "1.2.3+build..7",
])("rejects invalid version %s", version => {
  expect(callSchema.safeParse({ ...call, version }).success).toBe(false);
});

it.each(["0.0.0", "1.2.3-rc.1+build.7", "1.2.3+001", "1.2.3-0", "1.2.3-01a"])(
  "accepts exact SemVer %s",
  version => {
    expect(callSchema.parse({ ...call, version }).version).toBe(version);
  },
);
