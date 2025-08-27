export function getVersion(): string {
  try {
    if (typeof process !== "undefined" && process.env && process.env.npm_package_version) {
      return process.env.npm_package_version as string;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../../../package.json");
    return (pkg?.version as string) || "3.x.x";
  } catch {
    return "3.x.x";
  }
}

