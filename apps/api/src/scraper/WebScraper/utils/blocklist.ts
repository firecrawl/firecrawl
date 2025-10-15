import { configDotenv } from "dotenv";
import { parse } from "tldts";
import { TeamFlags } from "../../../controllers/v1/types";
import { supabase_rr_service } from "../../../services/supabase";

configDotenv();

type BlocklistBlob = {
  blocklist: string[];
  allowedKeywords: string[];
};

let blob: BlocklistBlob | null = null;

export async function initializeBlocklist() {
  if (
    process.env.USE_DB_AUTHENTICATION !== "true" ||
    process.env.DISABLE_BLOCKLIST === "true"
  ) {
    blob = {
      blocklist: [],
      allowedKeywords: [],
    };
    return;
  }

  const { data, error } = await supabase_rr_service
    .from("blocklist")
    .select("*")
    .single();

  if (error) {
    throw new Error(`Error getting blocklist: ${error.message}`);
  }

  if (!data) {
    throw new Error("Error getting blocklist: No data returned from database");
  }
  blob = data.data;
}

export function isUrlBlocked(url: string, flags: TeamFlags): boolean {
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
    blob.allowedKeywords.some(keyword =>
      lowerCaseUrl.includes(keyword.toLowerCase()),
    )
  ) {
    return false;
  }

  // Block exact matches
  if (blockedlist.includes(domain)) {
    return true;
  }

  // Block subdomains
  if (blockedlist.some(blocked => domain.endsWith(`.${blocked}`))) {
    return true;
  }

  // Block different TLDs of the same base domain
  const baseDomain = domain.split(".")[0]; // Extract the base domain (e.g., "facebook" from "facebook.com")
  if (
    publicSuffix &&
    blockedlist.some(
      blocked => blocked.startsWith(baseDomain + ".") && blocked !== domain,
    )
  ) {
    return true;
  }

  return false;
}
