import { NextResponse } from 'next/server';
import { getDb } from '@fire-enrich/db';

/**
 * Reports presence (boolean) of every env var the server needs to be
 * fully operational. Never leaks values. Used by the admin UI's
 * settings page and by ops smoke tests.
 *
 * `db` is true iff `getDb()` resolves without throwing — i.e.
 * DATABASE_URL is set. We don't run a query (cold-start cheap).
 */
export async function GET() {
  let dbReady = false;
  try {
    getDb();
    dbReady = true;
  } catch {
    dbReady = false;
  }

  const environmentStatus = {
    // Legacy keys (kept for backward-compat with any consumers)
    FIRECRAWL_API_KEY: !!process.env.FIRECRAWL_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    FIRESTARTER_DISABLE_CREATION_DASHBOARD:
      process.env.FIRESTARTER_DISABLE_CREATION_DASHBOARD === 'true',
    // Auth/DB readiness flags introduced in v2.
    db: dbReady,
    keyEncryptionKey: !!process.env.KEY_ENCRYPTION_KEY,
    serverPepper: !!process.env.SERVER_PEPPER,
    adminToken: !!process.env.ADMIN_TOKEN,
    adminCookieSecret: !!process.env.ADMIN_COOKIE_SECRET,
    pooledFirecrawl: !!process.env.FIRECRAWL_API_KEY,
    pooledOpenai: !!process.env.OPENAI_API_KEY,
  };

  return NextResponse.json({ environmentStatus });
}
