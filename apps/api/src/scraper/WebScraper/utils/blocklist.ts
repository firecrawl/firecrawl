import { configDotenv } from "dotenv";
import crypto from "crypto";
import { parse } from "tldts";
import { TeamFlags } from "../../../controllers/v1/types";

configDotenv();

const hashKey = Buffer.from(process.env.HASH_KEY || "", "utf-8");
const algorithm = "aes-256-ecb";

export function encryptAES(plaintext: string, key: Buffer): string {
  const cipher = crypto.createCipheriv(algorithm, key, null);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  return encrypted.toString("base64");
}

export function decryptAES(ciphertext: string, key: Buffer): string {
  const decipher = crypto.createDecipheriv(algorithm, key, null);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}

const urlBlocklist = [
  "h8ngAFXUNLO3ZqQufJjGVA==",
  "fEGiDm/TWDBkXUXejFVICg==",
  "l6Mei7IGbEmTTFoSudUnqQ==",
  "4OjallJzXRiZUAWDiC2Xww==",
  "ReSvkSfx34TNEdecmmSDdQ==",
  "X1E4WtdmXAv3SAX9xN925Q==",
  "VTzBQfMtXZzM05mnNkWkjA==",
  "m/q4Lb2Z8cxwU7/CoztOFg==",
  "UbVnmRaeG+gKcyVDLAm0vg==",
  "xNQhczYG22tTVc6lYE3qwg==",
  "CQfGDydbg4l1swRCru6O6Q==",
  "l86LQxm2NonTWMauXwEsPw==",
  "6v4QDUcwjnID80G+uU+tgw==",
  "pCF/6nrKZAxaYntzEGluZQ==",
  "r0CRhAmQqSe7V2s3073T00sAh4WcS5779jwuGJ26ows==",
  "aBOVqRFBM4UVg33usY10NdiF0HCnFH/ImtD0n+zIpc8==",
  "QV436UZuQ6D0Dqrx9MwaGw==",
  "OYVvrwILYbzA2mSSqOPPpw==",
  "xW2i4C0Dzcnp+qu12u0SAw==",
  "OLHba209l0dfl0MI4EnQonBITK9z8Qwgd/NsuaTkXmA=",
  "X0VynmNjpL3PrYxpUIG7sFMBt8OlrmQWtxj8oXVu2QM=",
  "ObdlM5NEkvBJ/sojRW5K/Q==",
  "C8Th38X0SjsE1vL/OsD8bA==",
  "PTbGg8PK/h0Seyw4HEpK4Q==",
  "lZdQMknjHb7+4+sjF3qNTw==",
  "LsgSq54q5oDysbva29JxnQ==",
  "KZfBtpwjOpdSoqacRbz7og==",
  "Indtl4yxJMHCKBGF4KABCQ==",
  "e3HFXLVgxhaVoadYpwb2BA==",
  "b+asgLayXQ5Jq+se+q56jA==",
  "86ZDUI7vmp4MvNq3fvZrGQ==",
  "sEGFoYZ6GEg4Zocd+TiyfQ==",
  "6OOL72eXthgnJ1Hj4PfOQQ==",
  "g/ME+Sh1CAFboKrwkVb+5Q==",
  "Pw+xawUoX8xBYbX2yqqGWQ==",
  "k6vBalxYFhAvkPsF19t9gQ==",
  "b+asgLayXQ5Jq+se+q56jA==",
  "KKttwRz4w+AMJrZcB828WQ==",
  "vMdzZ33BXoyWVZnAPOBcrg==",
  "l8GDVI8w/ueHnNzdN1ODuQ==",
  "+yz9bnYYMnC0trJZGJwf6Q==",
  "oTdhIjEjqdT2pEvyxD1Ssg==",
]

const allowedKeywords = [
  "pulse",
  "privacy",
  "terms",
  "policy",
  "user-agreement",
  "legal",
  "help",
  "policies",
  "support",
  "contact",
  "about",
  "careers",
  "blog",
  "press",
  "conditions",
  "tos",
  "://library.tiktok.com",
  "://ads.tiktok.com",
  "://tiktok.com/business",
  "://developers.facebook.com",
  "://developers.meta.com",
  "://facebook.com/ads/library",
  "://www.facebook.com/ads/library",
  "://meta.com/experiences",
  "://www.meta.com/experiences",
  "://creditcards.aa.com",
  "://aa.org",
  "://www.aa.org",
];

export function decryptedBlocklist(list: string[]): string[] {
  return hashKey.length > 0
    ? list.map((ciphertext) => decryptAES(ciphertext, hashKey))
    : [];
}

export function isUrlBlocked(url: string, flags: TeamFlags): boolean {
  const lowerCaseUrl = url.trim().toLowerCase();

  let blockedlist = decryptedBlocklist(urlBlocklist);

  if (flags?.unblockedDomains) {
    blockedlist = blockedlist.filter((blocked) => !flags.unblockedDomains!.includes(blocked));
  }

  const decryptedUrl =
    blockedlist.find((decrypted) => lowerCaseUrl === decrypted) ||
    lowerCaseUrl;

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
    allowedKeywords.some((keyword) =>
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
  if (blockedlist.some((blocked) => domain.endsWith(`.${blocked}`))) {
    return true;
  }

  // Block different TLDs of the same base domain
  const baseDomain = domain.split(".")[0]; // Extract the base domain (e.g., "facebook" from "facebook.com")
  if (
    publicSuffix &&
    blockedlist.some(
      (blocked) => blocked.startsWith(baseDomain + ".") && blocked !== domain,
    )
  ) {
    return true;
  }

  return false;
}