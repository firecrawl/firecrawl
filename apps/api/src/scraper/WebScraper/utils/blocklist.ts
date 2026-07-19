import { configDotenv } from "dotenv";
import { v7 as uuidv7 } from "uuid";
import { config } from "../../../config";
import { parse } from "tldts";
import { TeamFlags } from "../../../controllers/v1/types";
import { db, dbRr } from "../../../db/connection";
import * as schema from "../../../db/schema";

configDotenv();

type BlocklistBlob = {
  blocklist: string[];
  allowedKeywords: string[];
};

type BlockContext = {
  team_id?: string | null;
  org_id?: string | null;
  origin?: string | null;
};

type BlockHit = {
  id: string;
  domain: string;
  url: string;
  team_id: string | null;
  origin: string | null;
};

const HIT_BUFFER_FLUSH_MS = 5000;
const HIT_BUFFER_MAX_SIZE = 200;
let hitBuffer: BlockHit[] = [];
let hitFlushTimer: NodeJS.Timeout | null = null;

async function flushHits(): Promise<void> {
  if (hitBuffer.length === 0) return;
  const batch = hitBuffer;
  hitBuffer = [];
  if (config.USE_DB_AUTHENTICATION !== true) return;
  try {
    await db.insert(schema.blocklist_hits).values(batch);
  } catch {}
}

function scheduleHitFlush(): void {
  if (hitFlushTimer !== null) return;
  hitFlushTimer = setTimeout(() => {
    hitFlushTimer = null;
    void flushHits();
  }, HIT_BUFFER_FLUSH_MS);
  if (typeof hitFlushTimer.unref === "function") hitFlushTimer.unref();
}

function recordHit(
  url: string,
  domain: string,
  context: BlockContext | undefined,
): void {
  if (context === undefined) return;
  if (config.USE_DB_AUTHENTICATION !== true) return;
  hitBuffer.push({
    id: uuidv7(),
    domain,
    url: url.length > 2048 ? url.slice(0, 2048) : url,
    team_id: context.team_id ?? null,
    origin: context.origin ?? null,
  });
  if (hitBuffer.length >= HIT_BUFFER_MAX_SIZE) {
    if (hitFlushTimer !== null) {
      clearTimeout(hitFlushTimer);
      hitFlushTimer = null;
    }
    void flushHits();
  } else {
    scheduleHitFlush();
  }
}

function allowedKeywordMatches(url: string, allowedKeyword: string): boolean {
  const keyword = allowedKeyword.trim();
  if (!keyword) {
    return false;
  }

  if (keyword.startsWith("regex:")) {
    try {
      return new RegExp(keyword.slice("regex:".length), "i").test(url);
    } catch {
      return false;
    }
  }

  const regexMatch = keyword.match(/^\/(.+)\/([dgimsuvy]*)$/);
  if (regexMatch) {
    try {
      return new RegExp(regexMatch[1], regexMatch[2]).test(url);
    } catch {
      return false;
    }
  }

  return url.toLowerCase().includes(keyword.toLowerCase());
}

let blob: BlocklistBlob | null = null;
let orgBlobs: Map<string, BlocklistBlob> = new Map();

// Rows are written by ops directly, so reads must survive a missing or
// partial document — a bad row must never take down startup. Blank entries
// can never match and would make an org register as scoped, so drop them.
function parseStringEntries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      )
    : [];
}

function parseBlob(data: unknown): BlocklistBlob {
  const doc = (data ?? {}) as Record<string, unknown>;
  return {
    blocklist: parseStringEntries(doc.blocklist),
    allowedKeywords: parseStringEntries(doc.allowedKeywords),
  };
}

function mergeBlob(target: BlocklistBlob, source: BlocklistBlob): void {
  target.blocklist.push(...source.blocklist);
  target.allowedKeywords.push(...source.allowedKeywords);
}

// Rows may repeat entries; the match loops scan linearly, so dedupe once at
// load instead of paying for duplicates on every check.
function dedupeBlob(blob: BlocklistBlob): BlocklistBlob {
  return {
    blocklist: [...new Set(blob.blocklist)],
    allowedKeywords: [...new Set(blob.allowedKeywords)],
  };
}

export async function initializeBlocklist() {
  if (config.USE_DB_AUTHENTICATION !== true || config.DISABLE_BLOCKLIST) {
    blob = {
      blocklist: [],
      allowedKeywords: [],
    };
    orgBlobs = new Map();
    return;
  }

  let rows: { data: any; org_id: string | null }[];
  try {
    rows = await dbRr.select().from(schema.blocklist);
  } catch (error) {
    throw new Error(
      `Error getting blocklist: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }

  if (rows.length === 0) {
    throw new Error("Error getting blocklist: No data returned from database");
  }

  if (!rows.some(row => row.org_id === null)) {
    throw new Error(
      "Error getting blocklist: No global blocklist row (org_id IS NULL) found",
    );
  }

  const globalBlob: BlocklistBlob = { blocklist: [], allowedKeywords: [] };
  const perOrg = new Map<string, BlocklistBlob>();
  for (const row of rows) {
    if (row.org_id === null) {
      mergeBlob(globalBlob, parseBlob(row.data));
    } else {
      const existing = perOrg.get(row.org_id);
      if (existing) {
        mergeBlob(existing, parseBlob(row.data));
      } else {
        perOrg.set(row.org_id, parseBlob(row.data));
      }
    }
  }
  for (const [orgId, orgBlob] of perOrg) {
    const deduped = dedupeBlob(orgBlob);
    // An org whose rows hold no blockable entries must not register as
    // org-scoped at all — hasOrgScopedBlocklist consumers would otherwise
    // pay cache opt-outs for an org that can never block anything.
    if (deduped.blocklist.length === 0) {
      perOrg.delete(orgId);
    } else {
      perOrg.set(orgId, deduped);
    }
  }
  blob = dedupeBlob(globalBlob);
  orgBlobs = perOrg;
}

function findBlockedMatch(
  url: string,
  lowerCaseUrl: string,
  blockedlist: string[],
  allowedKeywords: string[],
): string | null {
  const decryptedUrl =
    blockedlist.find(decrypted => lowerCaseUrl === decrypted) || lowerCaseUrl;

  // If the URL is empty or invalid, return no match
  let parsedUrl: any;
  try {
    parsedUrl = parse(decryptedUrl);
  } catch {
    console.log("Error parsing URL:", url);
    return null;
  }

  const domain = parsedUrl.domain;
  const publicSuffix = parsedUrl.publicSuffix;

  if (!domain) {
    return null;
  }

  // Check if URL contains any allowed keyword
  if (allowedKeywords.some(keyword => allowedKeywordMatches(url, keyword))) {
    return null;
  }

  // Block exact matches
  if (blockedlist.includes(domain)) {
    return domain;
  }

  // Block subdomains
  if (blockedlist.some(blocked => domain.endsWith(`.${blocked}`))) {
    return domain;
  }

  // Block different TLDs of the same base domain
  const baseDomain = domain.split(".")[0]; // Extract the base domain (e.g., "facebook" from "facebook.com")

  if (
    publicSuffix &&
    baseDomain.length > 2 &&
    blockedlist.some(
      blocked => blocked.startsWith(baseDomain + ".") && blocked !== domain,
    )
  ) {
    return domain;
  }

  return null;
}

/**
 * Whether the org has any org-scoped blocklist entries at all. Lets shared
 * caches opt such requesters out entirely: a per-URL check is not enough
 * when the cached artifact covers other URLs than the one checked.
 */
export function hasOrgScopedBlocklist(
  orgId: string | null | undefined,
): boolean {
  if (blob === null) {
    throw new Error("Blocklist not initialized");
  }
  return typeof orgId === "string" && orgBlobs.has(orgId);
}

export function isUrlBlocked(
  url: string,
  flags: TeamFlags,
  context?: BlockContext,
): boolean {
  if (blob === null) {
    throw new Error("Blocklist not initialized");
  }

  const lowerCaseUrl = url.trim().toLowerCase();

  let blockedlist = [...blob.blocklist];

  if (flags?.unblockedDomains) {
    blockedlist = blockedlist.filter(
      blocked => !flags.unblockedDomains!.includes(blocked),
    );
  }

  const globalMatch = findBlockedMatch(
    url,
    lowerCaseUrl,
    blockedlist,
    blob.allowedKeywords,
  );
  if (globalMatch !== null) {
    recordHit(url, globalMatch, context);
    return true;
  }

  // The org blob's own allowedKeywords exempt URLs from the org list only.
  const orgBlob = context?.org_id ? orgBlobs.get(context.org_id) : undefined;
  if (orgBlob) {
    let orgBlockedlist = orgBlob.blocklist;
    if (flags?.unblockedDomains) {
      orgBlockedlist = orgBlockedlist.filter(
        blocked => !flags.unblockedDomains!.includes(blocked),
      );
    }
    const orgMatch = findBlockedMatch(
      url,
      lowerCaseUrl,
      orgBlockedlist,
      orgBlob.allowedKeywords,
    );
    if (orgMatch !== null) {
      recordHit(url, orgMatch, context);
      return true;
    }
  }

  return false;
}
