import { describe, expect, it, vi } from "vitest";
import {
  assertSafeOutboundDestination,
  assertSafeOutboundUrl,
  createSafeLookup,
  InsecureConnectionError,
} from "./outbound-url";
import type dns from "node:dns";

describe("outbound destination policy", () => {
  it.each([
    ["::ffff:8.8.8.8", true],
    ["::ffff:127.0.0.1", false],
    ["::ffff:169.254.169.254", false],
  ])(
    "classifies the mapped DNS answer %s by its IPv4 range",
    (address, allowed) => {
      const addresses = [{ address, family: 6 }];
      const resolve = vi.fn((_host, _options, callback) =>
        callback(null, addresses),
      );
      const lookup = createSafeLookup(
        () => false,
        resolve as unknown as typeof dns.lookup,
      );
      const callback = vi.fn();
      lookup("mapped.example", { all: true }, callback);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(
        ...(allowed ? [null, addresses] : [expect.any(Error)]),
      );
    },
  );
  it("preserves the security error across worker serialization", () => {
    const error = new InsecureConnectionError();
    const restored = InsecureConnectionError.deserialize(
      error.code,
      error.serialize(),
    );
    expect(restored.code).toBe("SCRAPE_UNSAFE_DESTINATION");
    expect(restored.message).toBe(error.message);
    expect(restored.stack).toBe(error.stack);
  });
  it.each([
    "http://127.0.0.1",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://169.254.169.254",
    "http://0",
    "http://[::1]",
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:169.254.169.254]",
    "http://[::ffff:192.168.1.1]",
    "http://[fe80::1]",
    "http://[fd00::1]",
    "http://localhost.",
    "http://api.localhost",
    "file:///etc/passwd",
    "ftp://example.com",
    "not a URL",
  ])("rejects %s", url => {
    expect(() => assertSafeOutboundUrl(url)).toThrow();
  });

  it.each([
    "https://example.com/path",
    "http://8.8.8.8",
    "http://[::ffff:8.8.8.8]",
    "https://[2606:4700:4700::1111]",
  ])("accepts %s", url =>
    expect(() => assertSafeOutboundUrl(url)).not.toThrow(),
  );

  it("allows private HTTP destinations only with an explicit operator override", () => {
    expect(() => assertSafeOutboundUrl("http://127.0.0.1", true)).not.toThrow();
    expect(() => assertSafeOutboundUrl("file:///etc/passwd", true)).toThrow();
  });

  it("rejects a mixed public/private DNS answer before returning any address", () => {
    const resolve = vi.fn((_host, _options, callback) =>
      callback(null, [
        { address: "8.8.8.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]),
    );
    const lookup = createSafeLookup(
      () => false,
      resolve as unknown as typeof dns.lookup,
    );
    const callback = vi.fn();
    lookup("mixed.example", { all: true }, callback);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("passes the validated DNS result to the socket without resolving again", () => {
    const addresses = [{ address: "8.8.8.8", family: 4 }];
    const resolve = vi.fn((_host, _options, callback) =>
      callback(null, addresses),
    );
    const lookup = createSafeLookup(
      () => false,
      resolve as unknown as typeof dns.lookup,
    );
    const callback = vi.fn();
    lookup("public.example", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, addresses);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("fails closed on DNS errors and empty answers", () => {
    for (const error of [new Error("DNS failed"), null]) {
      const resolve = vi.fn((_host, _options, callback) => callback(error, []));
      const lookup = createSafeLookup(
        () => false,
        resolve as unknown as typeof dns.lookup,
      );
      const callback = vi.fn();
      lookup("missing.example", { all: true }, callback);
      expect(callback).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(expect.any(Error));
    }
  });

  it("checks DNS before a remote handoff", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      assertSafeOutboundDestination("https://internal.example", false, resolve),
    ).rejects.toThrow();
    expect(resolve).toHaveBeenCalledWith("internal.example");
    resolve.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    await expect(
      assertSafeOutboundDestination("https://public.example", false, resolve),
    ).resolves.toBeUndefined();
  });

  it("does not resolve private literals or explicit local overrides", async () => {
    const resolve = vi.fn();
    await expect(
      assertSafeOutboundDestination("http://[::1]", false, resolve),
    ).rejects.toThrow();
    await expect(
      assertSafeOutboundDestination("http://internal.example", true, resolve),
    ).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
});
