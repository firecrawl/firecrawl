import assert from "node:assert/strict";
import test from "node:test";
import IPAddr from "ipaddr.js";

const isUnicast = (address: string): boolean =>
  IPAddr.process(address).range() === "unicast";

test("IPv4-mapped IPv6 loopback is not considered unicast", () => {
  assert.equal(isUnicast("::ffff:127.0.0.1"), false);
});

test("IPv4-mapped IPv6 private address is not considered unicast", () => {
  assert.equal(isUnicast("::ffff:10.0.0.1"), false);
});

test("IPv4-mapped IPv6 public address remains unicast", () => {
  assert.equal(isUnicast("::ffff:8.8.8.8"), true);
});
