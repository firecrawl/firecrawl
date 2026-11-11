import { version } from "../../../package.json";

/** The SDK's own version, inlined at build time so a host app's npm_package_version never replaces it. */
export function getVersion(): string {
  return version;
}
