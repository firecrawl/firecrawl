import koffi, { KoffiFunction } from "koffi";
import { join } from "path";
import { stat } from "fs/promises";
import { platform } from "os";

// TODO: add a timeout to the Rust transformer
const rustExecutablePath = join(
  process.cwd(),
  "sharedLibs/html-transformer/target/release/",
  platform() === "darwin" ? "libhtml_transformer.dylib" : "libhtml_transformer.so"
);

type TransformHtmlOptions = {
  html: string,
  url: string,
  include_tags: string[],
  exclude_tags: string[],
  only_main_content: boolean,
  omce_signatures?: string[],
};

class RustHTMLTransformer {
  private static instance: RustHTMLTransformer;
  private _extractLinks: KoffiFunction;
  private _extractImages: KoffiFunction;
  private _extractBaseHref: KoffiFunction;
  private _extractMetadata: KoffiFunction;
  private _transformHtml: KoffiFunction;
  private _freeString: KoffiFunction;
  private _getInnerJSON: KoffiFunction;
  private _extractAttributes: KoffiFunction;

  private constructor() {
    const lib = koffi.load(rustExecutablePath);
    this._freeString = lib.func("free_string", "void", ["string"]);
    const cstn = "CString:" + crypto.randomUUID();
    const freedResultString = koffi.disposable(cstn, "string", this._freeString);
    this._extractLinks = lib.func("extract_links", freedResultString, ["string"]);
    this._extractImages = lib.func("extract_images", freedResultString, ["string", "string"]);
    this._extractBaseHref = lib.func("extract_base_href", freedResultString, ["string", "string"]);
    this._extractMetadata = lib.func("extract_metadata", freedResultString, ["string"]);
    this._transformHtml = lib.func("transform_html", freedResultString, ["string"]);
    this._getInnerJSON = lib.func("get_inner_json", freedResultString, ["string"]);
    this._extractAttributes = lib.func("extract_attributes", freedResultString, ["string", "string"]);
  }

  public static async getInstance(): Promise<RustHTMLTransformer> {
    if (!RustHTMLTransformer.instance) {
      try {
        await stat(rustExecutablePath);
      } catch (_) {
        throw Error("Rust html-transformer shared library not found");
      }
      RustHTMLTransformer.instance = new RustHTMLTransformer();
    }
    return RustHTMLTransformer.instance;
  }

  public async extractLinks(html: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      this._extractLinks.async(html, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          resolve(JSON.parse(res));
        }
      });
    });
  }

  public async extractImages(html: string, baseUrl: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      this._extractImages.async(html, baseUrl, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          if (res.startsWith("RUSTFC:ERROR:")) {
            reject(new Error(res.replace("RUSTFC:ERROR:", "")));
          } else {
            resolve(JSON.parse(res));
          }
        }
      });
    });
  }

  public async extractBaseHref(html: string, url: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this._extractBaseHref.async(html, url, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }

  public async extractMetadata(html: string): Promise<any> {
    return new Promise<string[]>((resolve, reject) => {
      this._extractMetadata.async(html, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          resolve(JSON.parse(res));
        }
      });
    });
  }

  public async transformHtml(opts: TransformHtmlOptions): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this._transformHtml.async(JSON.stringify(opts), (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          if (res === "RUSTFC:ERROR" || res.startsWith("RUSTFC:ERROR:")) {
            reject(new Error(res.startsWith("RUSTFC:ERROR:") ? ("Something went wrong on the Rust side. " + res.split("RUSTFC:ERROR:")[1]) : "Something went wrong on the Rust side."));
          } else {
            resolve(res);
          }
        }
      });
    });
  }

  public async getInnerJSON(html: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this._getInnerJSON.async(html, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          if (res === "RUSTFC:ERROR") {
            reject(new Error("Something went wrong on the Rust side."));
          } else {
            resolve(res);
          }
        }
      });
    });
  }

  public async extractAttributes(html: string, options: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this._extractAttributes.async(html, options, (err: Error, res: string) => {
        if (err) {
          reject(err);
        } else {
          if (res.startsWith("RUSTFC:ERROR:")) {
            reject(new Error("Rust attribute extraction failed: " + res.split("RUSTFC:ERROR:")[1]));
          } else {
            resolve(res);
          }
        }
      });
    });
  }
}

export async function extractLinks(
  html: string | null | undefined,
): Promise<string[]> {
    if (!html) {
        return [];
    }

    const converter = await RustHTMLTransformer.getInstance();
    return await converter.extractLinks(html);
}

export async function extractImages(
  html: string | null | undefined,
  baseUrl: string = ''
): Promise<string[]> {
    if (!html) {
        return [];
    }

    const converter = await RustHTMLTransformer.getInstance();
    return await converter.extractImages(html, baseUrl);
}

export async function extractBaseHref(
  html: string | null | undefined,
  url: string
): Promise<string> {
    if (!html) {
        return url;
    }

    const converter = await RustHTMLTransformer.getInstance();
    return await converter.extractBaseHref(html, url);
}

export async function extractMetadata(
    html: string | null | undefined,
): Promise<any> {
    if (!html) {
        return [];
    }

    const converter = await RustHTMLTransformer.getInstance();
    return await converter.extractMetadata(html);
}

export async function transformHtml(
  opts: TransformHtmlOptions,
): Promise<string> {
  const converter = await RustHTMLTransformer.getInstance();
  return await converter.transformHtml(opts);
}

export async function getInnerJSON(
  html: string,
): Promise<string> {
  const converter = await RustHTMLTransformer.getInstance();
  return await converter.getInnerJSON(html);
}

export type AttributeSelector = {
  selector: string;
  attribute: string;
};

export type AttributeResult = {
  selector: string;
  attribute: string;
  values: string[];
};

export async function extractAttributesRust(
  html: string,
  selectors: AttributeSelector[]
): Promise<AttributeResult[]> {
  if (!html || selectors.length === 0) {
    return [];
  }

  const converter = await RustHTMLTransformer.getInstance();
  const options = JSON.stringify({ selectors });
  const resultJson = await converter.extractAttributes(html, options);

  try {
    return JSON.parse(resultJson);
  } catch (error) {
    throw new Error(`Failed to parse Rust attribute extraction result: ${error}`);
  }
}
