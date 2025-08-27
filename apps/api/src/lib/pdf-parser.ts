import koffi, { KoffiFunction } from "koffi";
import { join } from "path";
import { stat } from "fs/promises";
import { platform } from "os";

// TODO: add a timeout to the Rust parser
const rustExecutablePath = join(
    process.cwd(),
    "sharedLibs/pdf-parser/target/release/",
    platform() === "darwin" ? "libpdf_parser.dylib" : "libpdf_parser.so"
);

class RustPDFParser {
    private static instance: RustPDFParser;
    private _getPageCount: KoffiFunction;

    private constructor() {
        const lib = koffi.load(rustExecutablePath);
        this._getPageCount = lib.func("get_page_count", "int32", ["string"]);
    }

    public static async isParserAvailable(): Promise<boolean> {
        if (RustPDFParser.instance) {
            return true;
        }

        try {
            await stat(rustExecutablePath);
            RustPDFParser.instance = new RustPDFParser();
            return true;
        } catch (_) {
            return false;
        }
    }

    public static async getInstance(): Promise<RustPDFParser> {
        if (!RustPDFParser.instance) {
            try {
                await stat(rustExecutablePath);
            } catch (_) {
                throw Error("Rust pdf-parser shared library not found");
            }
            RustPDFParser.instance = new RustPDFParser();
        }
        return RustPDFParser.instance;
    }

    public async getPageCount(path: string): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            this._getPageCount.async(path, (err: Error, res: number) => {
                if (err) {
                    reject(err);
                } else {
                    if (res === -1) {
                        reject(new Error("Failed to parse PDF."));
                    } else {
                        resolve(res);
                    }
                }
            });
        });
    }
}

export async function getPageCount(
    path: string,
): Promise<number> {
    const converter = await RustPDFParser.getInstance();
    return await converter.getPageCount(path);
}
