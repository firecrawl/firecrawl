declare module "pdf-parse-fixed" {
  namespace PDFParse {
    interface Result {
      numpages: number;
      numrender: number;
      info: any;
      metadata: any;
      text: string;
      version: string;
    }

    interface Options {
      pagerender?: (pageData: any) => string;
      max?: number;
      version?: string;
    }
  }

  function PDFParse(
    dataBuffer: Buffer,
    options?: PDFParse.Options,
  ): Promise<PDFParse.Result>;

  export = PDFParse;
}
