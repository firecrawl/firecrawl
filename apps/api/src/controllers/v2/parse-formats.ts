import type { Response } from "express";
import type { RequestWithAuth } from "./types";
import { isImageOcrEnabled } from "../../lib/image-ocr-gate";
import type { ParseFormat } from "../../lib/parse-formats";
import { listParseFormats } from "../../lib/parse-formats";

type ParseFormatsResponse = {
  success: true;
  data: { formats: Array<ParseFormat> };
};

export async function parseFormatsController(
  _req: RequestWithAuth<
    Record<string, string>,
    ParseFormatsResponse,
    undefined
  >,
  res: Response<ParseFormatsResponse>,
) {
  res.setHeader("Cache-Control", "private, max-age=3600");
  return res.status(200).json({
    success: true,
    data: { formats: listParseFormats(isImageOcrEnabled()) },
  });
}
