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

export async function initializeBlocklist() {
  if (config.USE_DB_AUTHENTICATION !== true || config.DISABLE_BLOCKLIST) {
    blob = {
      blocklist: [],
      allowedKeywords: [],
    };
    return;
  }

  let data: { data: any } | undefined;
  try {
    [data] = await dbRr.select().from(schema.blocklist).limit(1);
  } catch (error) {
    throw new Error(
      `Error getting blocklist: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
    );
  }

  if (!data) {
    throw new Error("Error getting blocklist: No data returned from database");
  }
  blob = data.data;
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

  const decryptedUrl =
    blockedlist.find(decrypted => lowerCaseUrl === decrypted) || lowerCaseUrl;

  // If the URL is empty or invalid, return false
  let parsedUrl: any;
  try {
    parsedUrl = parse(decryptedUrl);
  } catch {
    console.log("Error parsing URL:", url);
    return false;
  }

  const domain = parsedUrl.domain;
  const publicSuffix = parsedUrl.publicSuffix;

  if (!domain) {
    return false;
  }

  // Check if URL contains any allowed keyword
  if (
    blob.allowedKeywords.some(keyword => allowedKeywordMatches(url, keyword))
  ) {
    return false;
  }

  // Block exact matches
  if (blockedlist.includes(domain)) {
    recordHit(url, domain, context);
    return true;
  }

  // Block subdomains
  if (blockedlist.some(blocked => domain.endsWith(`.${blocked}`))) {
    recordHit(url, domain, context);
    return true;
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
    recordHit(url, domain, context);
    return true;
  }

  return false;
}
