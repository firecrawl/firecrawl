import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowPrivateScraping } from './security-config';

test('private scrape targets remain blocked by default, including with a proxy', () => {
  assert.equal(allowPrivateScraping({}), false);
  assert.equal(
    allowPrivateScraping({ PROXY_SERVER: 'http://proxy:8080' }),
    false,
  );
  assert.equal(
    allowPrivateScraping({ ALLOW_PRIVATE_IP_SCRAPING: 'false' }),
    false,
  );
});

test('the explicit private scraping flag enables private targets', () => {
  for (const value of ['true', 'TRUE', '1', 'yes', 'on', 'y', 'enabled']) {
    assert.equal(allowPrivateScraping({ ALLOW_PRIVATE_IP_SCRAPING: value }), true);
  }
});

test('existing self-hosted webhook settings keep allowing private scraping', () => {
  assert.equal(allowPrivateScraping({ ALLOW_LOCAL_WEBHOOKS: 'true' }), true);
});
