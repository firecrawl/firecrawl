import { alexandriaClientIp } from "./alexandria-client-ip";

describe("alexandriaClientIp", () => {
  const forwarded = { "x-firecrawl-client-ip": "203.0.113.7" };

  it("uses the IP the hosted MCP forwards", () => {
    expect(
      alexandriaClientIp({ ip: "10.0.0.5", headers: forwarded, auth: { hostedMcp: true } }),
    ).toBe("203.0.113.7");
  });

  it("ignores the header from any other caller", () => {
    expect(alexandriaClientIp({ ip: "198.51.100.2", headers: forwarded, auth: {} })).toBe("198.51.100.2");
    expect(alexandriaClientIp({ ip: "198.51.100.2", headers: forwarded })).toBe("198.51.100.2");
  });

  it("ignores a forwarded value that is not an IP", () => {
    expect(
      alexandriaClientIp({
        ip: "10.0.0.5",
        headers: { "x-firecrawl-client-ip": "203.0.113.7, 198.51.100.2" },
        auth: { hostedMcp: true },
      }),
    ).toBe("10.0.0.5");
  });
});
