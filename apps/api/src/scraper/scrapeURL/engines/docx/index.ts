import { Meta } from "../..";
import { EngineScrapeResult } from "..";
import { downloadFile } from "../utils/downloadFile";
import mammoth from "mammoth";

export async function scrapeDOCX(meta: Meta): Promise<EngineScrapeResult> {
  const { response, tempFilePath } = await downloadFile(meta.id, meta.rewrittenUrl ?? meta.url, {
    headers: meta.options.headers,
    signal: meta.abort.asSignal(),
  });

  return {
    url: response.url,
    statusCode: response.status,

    html: (await mammoth.convertToHtml({ path: tempFilePath })).value,

    proxyUsed: "basic",
  };
}

export function docxMaxReasonableTime(meta: Meta): number {
  return 15000;
}
