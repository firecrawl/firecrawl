declare module "geoip-country" {
  export interface GeoIpCountryLookup {
    country: string;
    name: string;
    native: string;
    phone: Array<number>;
    continent: string;
    capital: string;
    currency: Array<string>;
    languages: Array<string>;
    continent_name: string;
  }

  export function lookup(ip: string): GeoIpCountryLookup | null;
}
