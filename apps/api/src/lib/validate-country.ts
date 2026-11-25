import {
  findCountryCodeByName as nativeFindCountryCodeByName,
  getCountry as nativeGetCountry,
  getCountryCodes as nativeGetCountryCodes,
  hasCountry as nativeHasCountry,
  validateCountry as nativeValidateCountry,
  type CountryInfo,
} from "@mendable/firecrawl-rs";

export type { CountryInfo };

/** Validate an ISO 3166-1 alpha-2 country code (ASCII case-insensitive). */
export function validateCountry(code: string): boolean {
  if (typeof code !== "string") {
    return false;
  }
  return nativeValidateCountry(code);
}

/** Look up country metadata by exact uppercase ISO 3166-1 alpha-2 code. */
export function getCountry(code: string): CountryInfo | undefined {
  if (typeof code !== "string") {
    return undefined;
  }
  return nativeGetCountry(code) ?? undefined;
}

/** Look up an uppercase ISO 3166-1 alpha-2 code by English country name (case-insensitive). */
export function findCountryCodeByName(name: string): string | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  return nativeFindCountryCodeByName(name) ?? undefined;
}

/**
 * Read-only ISO 3166-1 alpha-2 country catalog backed by the native static
 * table so the full metadata table does not live on the V8 heap.
 */
export const countries: Readonly<Record<string, CountryInfo>> = new Proxy(
  {} as Record<string, CountryInfo>,
  {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const entry = nativeGetCountry(prop);
        if (entry !== null) {
          return entry;
        }
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string" && nativeHasCountry(prop)) {
        return true;
      }
      return Reflect.has(target, prop);
    },
    ownKeys() {
      return nativeGetCountryCodes();
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && nativeHasCountry(prop)) {
        return {
          configurable: true,
          enumerable: true,
          get() {
            return nativeGetCountry(prop) ?? undefined;
          },
        };
      }
      return undefined;
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  },
);
