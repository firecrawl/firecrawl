import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const ADMIN_TOKEN = 'super-secret-admin-token-stable';

beforeAll(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.ADMIN_COOKIE_SECRET = 'cookie-hmac-secret-also-stable';
});

const { loginAdmin, requireAdmin, AdminUnauthorizedError, ADMIN_COOKIE_NAME } =
  await import('../admin.js');

afterEach(() => {
  // No mocks to reset; pure crypto.
});

describe('loginAdmin', () => {
  it('rejects an incorrect plaintext token', async () => {
    await expect(loginAdmin('wrong')).rejects.toBeInstanceOf(AdminUnauthorizedError);
  });

  it('returns a Set-Cookie header value on success', async () => {
    const setCookie = await loginAdmin(ADMIN_TOKEN);
    expect(setCookie).toMatch(new RegExp(`^${ADMIN_COOKIE_NAME}=`));
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);
  });
});

describe('requireAdmin', () => {
  it('throws AdminUnauthorizedError when no cookie is present', () => {
    const headers = new Headers();
    expect(() => requireAdmin(headers)).toThrow(AdminUnauthorizedError);
  });

  it('throws when cookie is malformed', () => {
    const headers = new Headers({ cookie: `${ADMIN_COOKIE_NAME}=garbage` });
    expect(() => requireAdmin(headers)).toThrow(AdminUnauthorizedError);
  });

  it('throws when cookie signature does not match', async () => {
    const setCookie = await loginAdmin(ADMIN_TOKEN);
    // Tamper the cookie value's signature
    const valuePart = setCookie.match(/^[^=]+=([^;]+)/)![1]!;
    const decoded = JSON.parse(Buffer.from(valuePart, 'base64').toString('utf8'));
    decoded.sig = 'tampered-signature';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64');
    const headers = new Headers({ cookie: `${ADMIN_COOKIE_NAME}=${tampered}` });
    expect(() => requireAdmin(headers)).toThrow(AdminUnauthorizedError);
  });

  it('throws when cookie is expired', async () => {
    const setCookie = await loginAdmin(ADMIN_TOKEN);
    const valuePart = setCookie.match(/^[^=]+=([^;]+)/)![1]!;
    const decoded = JSON.parse(Buffer.from(valuePart, 'base64').toString('utf8'));
    decoded.exp = Date.now() - 1000; // 1 sec ago
    const expired = Buffer.from(JSON.stringify(decoded)).toString('base64');
    const headers = new Headers({ cookie: `${ADMIN_COOKIE_NAME}=${expired}` });
    expect(() => requireAdmin(headers)).toThrow(AdminUnauthorizedError);
  });

  it('accepts a freshly-minted cookie', async () => {
    const setCookie = await loginAdmin(ADMIN_TOKEN);
    const value = setCookie.match(/^[^=]+=([^;]+)/)![1]!;
    const headers = new Headers({ cookie: `${ADMIN_COOKIE_NAME}=${value}` });
    expect(() => requireAdmin(headers)).not.toThrow();
  });

  it('extracts the admin cookie among other cookies', async () => {
    const setCookie = await loginAdmin(ADMIN_TOKEN);
    const value = setCookie.match(/^[^=]+=([^;]+)/)![1]!;
    const headers = new Headers({
      cookie: `other=foo; ${ADMIN_COOKIE_NAME}=${value}; trailing=bar`,
    });
    expect(() => requireAdmin(headers)).not.toThrow();
  });
});
