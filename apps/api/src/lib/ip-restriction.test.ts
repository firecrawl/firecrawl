import { isIpAllowed, normalizeIp } from "./ip-restriction";

describe("normalizeIp", () => {
  it("strips the IPv4-mapped IPv6 prefix", () => {
    expect(normalizeIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("::FFFF:1.2.3.4")).toBe("1.2.3.4");
  });

  it("leaves plain addresses untouched", () => {
    expect(normalizeIp("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp(" 1.2.3.4 ")).toBe("1.2.3.4");
  });

  it("does not strip the prefix from non-IPv4 remainders", () => {
    expect(normalizeIp("::ffff:dead:beef")).toBe("::ffff:dead:beef");
  });
});

describe("isIpAllowed", () => {
  it("matches exact IPv4 addresses", () => {
    expect(isIpAllowed("1.2.3.4", ["1.2.3.4"])).toBe(true);
    expect(isIpAllowed("1.2.3.5", ["1.2.3.4"])).toBe(false);
  });

  it("matches IPv4 CIDR blocks", () => {
    expect(isIpAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(isIpAllowed("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(isIpAllowed("192.168.1.77", ["192.168.1.0/24"])).toBe(true);
    expect(isIpAllowed("192.168.2.77", ["192.168.1.0/24"])).toBe(false);
  });

  it("matches exact IPv6 addresses and CIDR blocks", () => {
    expect(isIpAllowed("2001:db8::1", ["2001:db8::1"])).toBe(true);
    expect(isIpAllowed("2001:db8::2", ["2001:db8::1"])).toBe(false);
    expect(isIpAllowed("2001:db8:1:2::3", ["2001:db8::/32"])).toBe(true);
    expect(isIpAllowed("2001:db9::1", ["2001:db8::/32"])).toBe(false);
  });

  it("matches IPv4-mapped IPv6 clients against IPv4 entries", () => {
    expect(isIpAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(isIpAllowed("::ffff:11.1.2.3", ["10.0.0.0/8"])).toBe(false);
  });

  it("supports match-all CIDR blocks", () => {
    expect(isIpAllowed("127.0.0.1", ["0.0.0.0/0"])).toBe(true);
    expect(isIpAllowed("::1", ["::/0"])).toBe(true);
    expect(isIpAllowed("::1", ["0.0.0.0/0"])).toBe(false);
  });

  it("checks against all entries", () => {
    const entries = ["1.2.3.4", "10.0.0.0/8", "2001:db8::/32"];
    expect(isIpAllowed("1.2.3.4", entries)).toBe(true);
    expect(isIpAllowed("10.9.9.9", entries)).toBe(true);
    expect(isIpAllowed("2001:db8::7", entries)).toBe(true);
    expect(isIpAllowed("8.8.8.8", entries)).toBe(false);
  });

  it("skips malformed entries without disabling valid ones", () => {
    const entries = [
      "not-an-ip",
      "10.0.0.0/33",
      "10.0.0.0/-1",
      "1.2.3.4/x",
      "1.2.3.4",
    ];
    expect(isIpAllowed("1.2.3.4", entries)).toBe(true);
    expect(isIpAllowed("10.0.0.1", entries)).toBe(false);
  });

  it("rejects malformed client IPs and empty allowlists", () => {
    expect(isIpAllowed("not-an-ip", ["0.0.0.0/0"])).toBe(false);
    expect(isIpAllowed("1.2.3.4", [])).toBe(false);
  });
});
