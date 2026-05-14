import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const ADMIN_TOKEN = 'super-secret-admin-token-stable';

beforeAll(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.ADMIN_COOKIE_SECRET = 'cookie-hmac-secret-also-stable';
});

afterEach(() => {
  delete process.env.OPS_AUTH_MODE;
  delete process.env.OPERATOR_EMAILS;
});

const {
  loginAdmin,
  requireOperator,
  requireAdmin,
  AdminUnauthorizedError,
  ADMIN_COOKIE_NAME,
} = await import('../admin.js');

async function freshCookieHeaders(): Promise<Headers> {
  const setCookie = await loginAdmin(ADMIN_TOKEN);
  const value = setCookie.match(/^[^=]+=([^;]+)/)![1]!;
  return new Headers({ cookie: `${ADMIN_COOKIE_NAME}=${value}` });
}

describe('requireOperator — admin-token mode (default)', () => {
  it('returns admin identity for a valid cookie', async () => {
    const headers = await freshCookieHeaders();
    const id = requireOperator(headers);
    expect(id).toEqual({ email: 'admin', source: 'admin-token' });
  });

  it('ignores X-Auth-User-Email when OPS_AUTH_MODE is unset', async () => {
    const headers = await freshCookieHeaders();
    headers.set('x-auth-user-email', 'evil@attacker.example');
    const id = requireOperator(headers);
    expect(id.email).toBe('admin'); // proxy header is *not* trusted in default mode
    expect(id.source).toBe('admin-token');
  });
});

describe('requireOperator — proxy mode', () => {
  it('returns the proxy email when X-Auth-User-Email is present', () => {
    process.env.OPS_AUTH_MODE = 'proxy';
    const headers = new Headers({ 'x-auth-user-email': 'theo@speccon.co.za' });
    const id = requireOperator(headers);
    expect(id).toEqual({ email: 'theo@speccon.co.za', source: 'cf-access' });
  });

  it('throws when the proxy header is missing', () => {
    process.env.OPS_AUTH_MODE = 'proxy';
    expect(() => requireOperator(new Headers())).toThrow(AdminUnauthorizedError);
  });

  it('rejects emails not in OPERATOR_EMAILS', () => {
    process.env.OPS_AUTH_MODE = 'proxy';
    process.env.OPERATOR_EMAILS = 'theo@speccon.co.za, alice@example.com';
    const headers = new Headers({ 'x-auth-user-email': 'evil@attacker.example' });
    expect(() => requireOperator(headers)).toThrow(/allowlist/);
  });

  it('accepts emails in OPERATOR_EMAILS, case-insensitive', () => {
    process.env.OPS_AUTH_MODE = 'proxy';
    process.env.OPERATOR_EMAILS = 'theo@speccon.co.za';
    const headers = new Headers({ 'x-auth-user-email': 'Theo@SpecCon.co.za' });
    const id = requireOperator(headers);
    expect(id.email).toBe('Theo@SpecCon.co.za');
  });

  it('does NOT accept the admin cookie as a fallback in pure proxy mode', async () => {
    // Mint the cookie first under default mode (proxy mode would refuse to mint).
    const headers = await freshCookieHeaders();
    process.env.OPS_AUTH_MODE = 'proxy';
    expect(() => requireOperator(headers)).toThrow(AdminUnauthorizedError);
  });
});

describe('requireOperator — either mode', () => {
  it('prefers the proxy header when present', () => {
    process.env.OPS_AUTH_MODE = 'either';
    const headers = new Headers({ 'x-auth-user-email': 'theo@speccon.co.za' });
    const id = requireOperator(headers);
    expect(id.source).toBe('cf-access');
  });

  it('falls back to the cookie when the header is missing', async () => {
    process.env.OPS_AUTH_MODE = 'either';
    const headers = await freshCookieHeaders();
    const id = requireOperator(headers);
    expect(id.source).toBe('admin-token');
  });

  it('throws when neither header nor cookie is present', () => {
    process.env.OPS_AUTH_MODE = 'either';
    expect(() => requireOperator(new Headers())).toThrow(AdminUnauthorizedError);
  });
});

describe('loginAdmin gating', () => {
  it('refuses to mint a cookie when OPS_AUTH_MODE=proxy', async () => {
    process.env.OPS_AUTH_MODE = 'proxy';
    await expect(loginAdmin(ADMIN_TOKEN)).rejects.toThrow(/disabled/);
  });

  it('still mints a cookie when OPS_AUTH_MODE=either', async () => {
    process.env.OPS_AUTH_MODE = 'either';
    const setCookie = await loginAdmin(ADMIN_TOKEN);
    expect(setCookie).toMatch(new RegExp(`^${ADMIN_COOKIE_NAME}=`));
  });
});

describe('requireAdmin (legacy wrapper) is unchanged', () => {
  it('still works as void-returning gate', async () => {
    const headers = await freshCookieHeaders();
    expect(() => requireAdmin(headers)).not.toThrow();
  });
});
