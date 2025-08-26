import { InternalOptions } from "..";
import { ScrapeOptions } from "../../../controllers/v2/types"; // Fix: Use v2 types, not v1

export type UrlSpecificParams = {
  scrapeOptions: Partial<ScrapeOptions>;
  internalOptions: Partial<InternalOptions>;
};

// Simple, clean configuration for domains with anti-bot protection
const ANTI_BOT_DOMAINS = new Set([
  "mp.weixin.qq.com",
  "weixin.qq.com", 
  "linkedin.com",
  "twitter.com",
  "x.com", 
  "facebook.com",
  "instagram.com"
]);

/**
 * Check if a domain should disable auto proxy switching
 */
export function shouldDisableAutoProxySwitch(hostname: string): boolean {
  const normalizedHostname = hostname.replace(/^www\./, "");
  
  // Check exact match
  if (ANTI_BOT_DOMAINS.has(normalizedHostname)) {
    return true;
  }
  
  // Check subdomain match
  for (const domain of ANTI_BOT_DOMAINS) {
    if (normalizedHostname.endsWith('.' + domain)) {
      return true;
    }
  }
  
  return false;
}

export const urlSpecificParams: Record<string, UrlSpecificParams> = {
  // WeChat domains - use basic proxy to avoid robot protection
  "mp.weixin.qq.com": {
    scrapeOptions: { 
      proxy: "basic",
      timeout: 45000,
      waitFor: 1000
    },
    internalOptions: {},
  },
  "weixin.qq.com": {
    scrapeOptions: { 
      proxy: "basic",
      timeout: 45000 
    },
    internalOptions: {},
  },
  // Other sensitive domains that may have similar issues
  "linkedin.com": {
    scrapeOptions: { 
      proxy: "basic" 
    },
    internalOptions: {},
  },
  "twitter.com": {
    scrapeOptions: { 
      proxy: "basic" 
    },
    internalOptions: {},
  },
  "x.com": {
    scrapeOptions: { 
      proxy: "basic" 
    },
    internalOptions: {},
  },
  "facebook.com": {
    scrapeOptions: { 
      proxy: "basic" 
    },
    internalOptions: {},
  },
  "instagram.com": {
    scrapeOptions: { 
      proxy: "basic" 
    },
    internalOptions: {},
  },
  
  // Existing engine-specific configurations
  "digikey.com": {
    scrapeOptions: {},
    internalOptions: { forceEngine: "fire-engine;tlsclient" },
  },
  "lorealparis.hu": {
    scrapeOptions: {},
    internalOptions: { forceEngine: "fire-engine;tlsclient" },
  },
};
