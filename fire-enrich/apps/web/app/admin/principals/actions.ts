'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';

import {
  AdminUnauthorizedError,
  requireAdmin,
} from '@fire-enrich/core/server';
import { getDb, revokePrincipal } from '@fire-enrich/db';

export interface RevokeResult {
  ok: boolean;
  error?: string;
}

/**
 * Server action: revoke a principal by id.
 *
 * Re-checks the admin cookie via `requireAdmin` even though middleware
 * also gates the parent page — actions can be called from anywhere a
 * cookie is presented, so the auth check belongs here too.
 */
export async function revokePrincipalAction(id: string): Promise<RevokeResult> {
  try {
    requireAdmin(await headers());
  } catch (err) {
    if (err instanceof AdminUnauthorizedError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  if (!id) {
    return { ok: false, error: 'missing id' };
  }

  const db = getDb();
  const revoked = await revokePrincipal(id, db);
  if (!revoked) {
    return { ok: false, error: `principal ${id} not found` };
  }

  revalidatePath('/admin/principals');
  return { ok: true };
}
