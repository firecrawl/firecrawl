import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as dns from 'node:dns';

const MOD_PATH = require.resolve('./url-safety');

describe('assertSafeTargetUrl', () => {
  beforeEach(() => {
    delete require.cache[MOD_PATH];
    delete process.env.ALLOW_LOCAL_WEBHOOKS;
    delete process.env.ALLOW_PRIVATE_IP_SCRAPING;
  });

  it('blocks a private/internal IP when ALLOW_PRIVATE_IP_SCRAPING is false', async () => {
    process.env.ALLOW_PRIVATE_IP_SCRAPING = 'False';
    process.env.ALLOW_LOCAL_WEBHOOKS = 'False';

    const {
      assertSafeTargetUrl,
      InsecureConnectionError,
    }: typeof import('./url-safety') = require('./url-safety');

    await assert.rejects(
      () => assertSafeTargetUrl('http://127.0.0.1/'),
      (err: unknown) => {
        assert.ok(err instanceof InsecureConnectionError);
        assert.ok((err as Error).message.includes('private/internal address'));
        return true;
      },
    );
  });

  it('allows a private/internal IP when ALLOW_PRIVATE_IP_SCRAPING is true', async () => {
    process.env.ALLOW_PRIVATE_IP_SCRAPING = 'True';

    const { assertSafeTargetUrl }: typeof import('./url-safety') =
      require('./url-safety');

    await assert.doesNotReject(() =>
      assertSafeTargetUrl('http://10.0.0.1/'),
    );
  });

  it('also allows private targets when ALLOW_LOCAL_WEBHOOKS is true', async () => {
    process.env.ALLOW_LOCAL_WEBHOOKS = 'True';
    process.env.ALLOW_PRIVATE_IP_SCRAPING = 'False';

    const { assertSafeTargetUrl }: typeof import('./url-safety') =
      require('./url-safety');

    await assert.doesNotReject(() =>
      assertSafeTargetUrl('http://192.168.1.1/'),
    );
  });

  it('allows public unicast targets regardless of the flags', async () => {
    process.env.ALLOW_PRIVATE_IP_SCRAPING = 'False';
    process.env.ALLOW_LOCAL_WEBHOOKS = 'False';

    const { assertSafeTargetUrl }: typeof import('./url-safety') =
      require('./url-safety');

    await assert.doesNotReject(() =>
      assertSafeTargetUrl('http://1.1.1.1/'),
    );
  });

  it('allows a public IPv6 literal target (URL.hostname brackets it)', async () => {
    process.env.ALLOW_PRIVATE_IP_SCRAPING = 'False';
    process.env.ALLOW_LOCAL_WEBHOOKS = 'False';

    const { assertSafeTargetUrl }: typeof import('./url-safety') =
      require('./url-safety');

    await assert.doesNotReject(() =>
      assertSafeTargetUrl('http://[2606:4700::1111]/'),
    );
  });

  it('blocks the IPv6 loopback literal', async () => {
    process.env.ALLOW_PRIVATE_IP_SCRAPING = 'False';
    process.env.ALLOW_LOCAL_WEBHOOKS = 'False';

    const {
      assertSafeTargetUrl,
      InsecureConnectionError,
    }: typeof import('./url-safety') = require('./url-safety');

    await assert.rejects(
      () => assertSafeTargetUrl('http://[::1]/'),
      (err: unknown) => {
        assert.ok(err instanceof InsecureConnectionError);
        assert.ok((err as Error).message.includes('private/internal address'));
        return true;
      },
    );
  });
});

describe('resolvePublicHostAddresses', () => {
  it('returns a public IPv4 literal', async () => {
    const { resolvePublicHostAddresses } = require('./url-safety');
    const addresses = await resolvePublicHostAddresses('1.1.1.1');
    assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]);
  });

  it('returns a public IPv6 literal (brackets stripped)', async () => {
    const { resolvePublicHostAddresses } = require('./url-safety');
    const addresses = await resolvePublicHostAddresses('[2606:4700::1111]');
    assert.deepEqual(addresses, [{ address: '2606:4700::1111', family: 6 }]);
  });

  it('returns null for an IPv4 loopback literal', async () => {
    const { resolvePublicHostAddresses } = require('./url-safety');
    const addresses = await resolvePublicHostAddresses('127.0.0.1');
    assert.strictEqual(addresses, null);
  });

  it('returns null for an IPv6 loopback literal', async () => {
    const { resolvePublicHostAddresses } = require('./url-safety');
    const addresses = await resolvePublicHostAddresses('[::1]');
    assert.strictEqual(addresses, null);
  });

  it('returns null for localhost', async () => {
    const { resolvePublicHostAddresses } = require('./url-safety');
    const addresses = await resolvePublicHostAddresses('localhost');
    assert.strictEqual(addresses, null);
  });

  it('returns null when DNS resolution fails', async () => {
    const { resolvePublicHostAddresses } = require('./url-safety');
    const addresses = await resolvePublicHostAddresses(
      'this-should-not-exist.invalid',
    );
    assert.strictEqual(addresses, null);
  });
});

describe('createSafeDnsLookup', () => {
  it('returns the pinned addresses when called with all: true', async () => {
    const { createSafeDnsLookup } = require('./url-safety');
    const dnsLookup: typeof dns['lookup'] = createSafeDnsLookup([
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);

    const all = await new Promise<unknown>((resolve, reject) => {
      dnsLookup(
        'example.com',
        { all: true },
        (err, addresses: unknown) => {
          if (err) reject(err);
          else resolve(addresses);
        },
      );
    });

    assert.deepEqual(all, [
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);
  });

  it('returns an IPv4 address when the family hint is 4', async () => {
    const { createSafeDnsLookup } = require('./url-safety');
    const dnsLookup: typeof dns['lookup'] = createSafeDnsLookup([
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700::1111', family: 6 },
    ]);

    const result = await new Promise<[string, number]>((resolve, reject) => {
      dnsLookup('example.com', { family: 4 }, (err, address, family) => {
        if (err) reject(err);
        else resolve([address as string, family as number]);
      });
    });

    assert.deepEqual(result, ['1.1.1.1', 4]);
  });

  it('falls back to any pinned address when the family filter does not match', async () => {
    const { createSafeDnsLookup } = require('./url-safety');
    const dnsLookup: typeof dns['lookup'] = createSafeDnsLookup([
      { address: '2606:4700::1111', family: 6 },
    ]);

    const result = await new Promise<[string, number]>((resolve, reject) => {
      dnsLookup('example.com', { family: 4 }, (err, address, family) => {
        if (err) reject(err);
        else resolve([address as string, family as number]);
      });
    });

    assert.deepEqual(result, ['2606:4700::1111', 6]);
  });
});
