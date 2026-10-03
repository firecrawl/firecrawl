import { isIPPrivate } from "./safeFetch";

describe("isIPPrivate", () => {
  it("treats bracketed IPv6 localhost hostnames as private", () => {
    expect(isIPPrivate("[::1]")).toBe(true);
  });

  it("treats bracketed IPv4-mapped localhost hostnames as private", () => {
    expect(isIPPrivate("[::ffff:7f00:1]")).toBe(true);
  });
});
