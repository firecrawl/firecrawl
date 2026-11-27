declare module "pdf-parse" {
  function PdfParse(
    dataBuffer: Buffer | Uint8Array,
    options?: PdfParse.Options,
  ): Promise<PdfParse.Result>;

  namespace PdfParse {
    type Version =
      | "default"
      | "v1.9.426"
      | "v1.10.100"
      | "v1.10.88"
      | "v2.0.550";
    interface Result {
      numpages: number;
      numrender: number;
      info: unknown;
      metadata: unknown;
      version: Version;
      text: string;
    }
    interface Options {
      pagerender?: ((pageData: unknown) => string) | undefined;
      max?: number | undefined;
      version?: Version | undefined;
    }
  }

  export = PdfParse;
}
