import { Response } from "express";
import { RequestWithAuth } from "./types";
import { isImageOcrEnabled } from "../../lib/image-ocr-gate";
import { listParseFormats, ParseFormat } from "../../lib/parse-formats";

type ParseFormatsResponse = {
  success: true;
  data: { formats: ParseFormat[] };
};

export async function parseFormatsController(
  _req: RequestWithAuth<{}, ParseFormatsResponse, undefined>,
  res: Response<ParseFormatsResponse>,
) {
  res.setHeader("Cache-Control", "private, max-age=3600");
  return res.status(200).json({
    success: true,
    data: { formats: listParseFormats(isImageOcrEnabled()) },
  });
}
