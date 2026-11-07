import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldWarnNoProxy,
  createProxyWarningEmitter,
  NO_PROXY_WARNING_MESSAGE,
} from "./proxy_warning";

test("shouldWarnNoProxy returns true when no proxy is provided and warnings are not silenced", () => {
  assert.equal(shouldWarnNoProxy(null, null, null), true);
  assert.equal(shouldWarnNoProxy(undefined, undefined, undefined), true);
  assert.equal(shouldWarnNoProxy("", "", ""), true);
});

test("shouldWarnNoProxy returns false when proxy server is provided", () => {
  assert.equal(
    shouldWarnNoProxy("http://proxy.example.com:8080", null, null),
    false,
  );
  assert.equal(
    shouldWarnNoProxy("proxy.example.com:8080", "true", "false"),
    false,
  );
});

test("shouldWarnNoProxy respects WARN_NO_PROXY=false", () => {
  assert.equal(shouldWarnNoProxy(null, "false", null), false);
  assert.equal(shouldWarnNoProxy(null, "FALSE", null), false);
  assert.equal(shouldWarnNoProxy(null, "False", null), false);
});

test("shouldWarnNoProxy respects SILENCE_PROXY_WARNING=true", () => {
  assert.equal(shouldWarnNoProxy(null, null, "true"), false);
  assert.equal(shouldWarnNoProxy(null, null, "TRUE"), false);
  assert.equal(shouldWarnNoProxy(null, null, "True"), false);
  assert.equal(shouldWarnNoProxy(null, null, "1"), false);
});

test("createProxyWarningEmitter logs warning exactly once and suppresses repeats", () => {
  const logged: string[] = [];
  const warnFn = (msg: string) => {
    logged.push(msg);
  };

  const emitter = createProxyWarningEmitter({
    proxyServer: null,
    warnNoProxy: "true",
    silenceProxyWarning: "false",
    warnFn,
  });

  // First call should warn
  const first = emitter();
  assert.equal(first, true);
  assert.equal(logged.length, 1);
  assert.equal(logged[0], NO_PROXY_WARNING_MESSAGE);

  // Subsequent calls should be suppressed
  const second = emitter();
  assert.equal(second, false);
  const third = emitter();
  assert.equal(third, false);
  assert.equal(logged.length, 1);
});

test("createProxyWarningEmitter does not log when silenced", () => {
  const logged: string[] = [];
  const warnFn = (msg: string) => {
    logged.push(msg);
  };

  const emitter = createProxyWarningEmitter({
    proxyServer: null,
    warnNoProxy: "false",
    silenceProxyWarning: "false",
    warnFn,
  });

  const res = emitter();
  assert.equal(res, false);
  assert.equal(logged.length, 0);
});
