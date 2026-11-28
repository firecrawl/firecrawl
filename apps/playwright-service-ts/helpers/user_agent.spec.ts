import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDesktopChromeUserAgent,
  resolveContextUserAgent,
} from './user_agent';

test('buildDesktopChromeUserAgent matches Chromium version and desktop OS token without HeadlessChrome', () => {
  assert.equal(
    buildDesktopChromeUserAgent('158.0.8127.18', 'linux'),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36',
  );
  assert.equal(
    buildDesktopChromeUserAgent('HeadlessChrome/158.0.8127.18', 'darwin'),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36',
  );
  assert.equal(
    buildDesktopChromeUserAgent('Chrome/158.0.8127.18', 'win32'),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36',
  );
  assert.equal(buildDesktopChromeUserAgent(''), undefined);
  assert.equal(buildDesktopChromeUserAgent('invalid version'), undefined);
});

test('resolveContextUserAgent preserves explicit overrides and ignores blank strings', () => {
  const defaultUa =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36';
  assert.equal(
    resolveContextUserAgent('CustomBot/1.0', defaultUa),
    'CustomBot/1.0',
  );
  assert.equal(resolveContextUserAgent(undefined, defaultUa), defaultUa);
  assert.equal(resolveContextUserAgent('   ', defaultUa), defaultUa);
});

test('resolveContextUserAgent fallback never emits mobile user agents', () => {
  for (let i = 0; i < 50; i++) {
    const ua = resolveContextUserAgent(undefined, undefined);
    assert.ok(ua.length > 0);
    assert.equal(
      /\b(?:Mobile|iPhone|iPad|iPod|Android)\b/i.test(ua),
      false,
      `unexpected mobile user agent: ${ua}`,
    );
  }
});
