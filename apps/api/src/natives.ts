import { platform } from "os";
import { join } from "path";

const currentPlatform = platform();
const isWindows = currentPlatform === "win32";

const EXTENSIONS = {
  win32: ".dll",
  darwin: ".dylib",
  default: ".so",
} as const;

function createNativePath(subPath: string, filename: string): string {
  const extension =
    EXTENSIONS[currentPlatform as keyof typeof EXTENSIONS] ??
    EXTENSIONS.default;
  const fullFilename = `${isWindows ? "" : "lib"}${filename}${extension}`;
  return join(process.cwd(), "sharedLibs", subPath, fullFilename);
}

export const HTML_TO_MARKDOWN_PATH = createNativePath(
  "go-html-to-md",
  "html-to-markdown",
);
