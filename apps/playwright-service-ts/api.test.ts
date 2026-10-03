import assert from "node:assert/strict";
import test from "node:test";
import { isInternalHost } from "./api";

test("IPv4-mapped IPv6 loopback is treated as internal", async () => {
  assert.equal(await isInternalHost("::ffff:127.0.0.1"), true);
});

test("IPv4-mapped IPv6 private address is treated as internal", async () => {
  assert.equal(await isInternalHost("::ffff:10.0.0.1"), true);
});

test("public IPv4-mapped IPv6 address remains external", async () => {
  assert.equal(await isInternalHost("::ffff:8.8.8.8"), false);
});
