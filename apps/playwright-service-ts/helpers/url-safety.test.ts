import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
});
