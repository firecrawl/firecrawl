import type { Meta } from "./context";
import type { Document, FormatObject } from "../../controllers/v2/types";
import { hasFormatOfType } from "../../lib/format-utils";

type FormatType = FormatObject["type"];

type Rule = {
  format: FormatType;
  key: keyof Document;
  warnStray: boolean;
  missingLabel?: string;
};

const RULES: Rule[] = [
  { format: "markdown", key: "markdown", warnStray: false },
  { format: "rawHtml", key: "rawHtml", warnStray: false },
  { format: "html", key: "html", warnStray: false },
  {
    format: "screenshot",
    key: "screenshot",
    warnStray: true,
    missingLabel: "screenshot / screenshot@fullPage",
  },
  { format: "links", key: "links", warnStray: true },
  { format: "images", key: "images", warnStray: true },
  { format: "summary", key: "summary", warnStray: true },
  { format: "query", key: "answer", warnStray: true, missingLabel: "query" },
  { format: "branding", key: "branding", warnStray: true },
  { format: "attributes", key: "attributes", warnStray: true },
  { format: "audio", key: "audio", warnStray: false },
  { format: "changeTracking", key: "changeTracking", warnStray: true },
];

/**
 * Final projection: trim the populated Document down to only the fields the
 * caller actually asked for. Warns when a requested format ended up missing
 * (bug upstream) or a non-requested field slipped in (wasted work upstream).
 */
export function shapeForFormats(meta: Meta, document: Document): Document {
  for (const r of RULES) {
    const requested = !!hasFormatOfType(meta.options.formats, r.format);
    const present = document[r.key] !== undefined;
    if (!requested && present) {
      if (r.warnStray) {
        meta.logger.warn(
          `Removed ${String(r.key)} from Document because format ${r.format} wasn't requested.`,
        );
      }
      delete document[r.key];
    } else if (requested && !present) {
      meta.logger.warn(
        `Request had format: ${r.missingLabel ?? r.format}, but no ${String(r.key)} field in the result.`,
      );
    }
  }

  // json/extract share one format (v1 back-compat preserves whichever v1 caller asked for).
  const hasJson = !!hasFormatOfType(meta.options.formats, "json");
  const keepExtract = meta.internalOptions.v1OriginalFormat === "extract";
  const keepJson = meta.internalOptions.v1OriginalFormat === "json";
  if (!hasJson) {
    if (document.extract !== undefined && !keepExtract) {
      meta.logger.warn(
        "Removed extract from Document (json format not requested).",
      );
      delete document.extract;
    }
    if (document.json !== undefined && !keepJson) {
      meta.logger.warn(
        "Removed json from Document (json format not requested).",
      );
      delete document.json;
    }
  } else if (document.extract === undefined && document.json === undefined) {
    meta.logger.warn(
      "Request had format json, but no json field in the result.",
    );
  }

  const ct = hasFormatOfType(meta.options.formats, "changeTracking");
  if (document.changeTracking) {
    if (
      !ct?.modes?.includes("git-diff") &&
      document.changeTracking.diff !== undefined
    ) {
      meta.logger.warn(
        "Removed diff from changeTracking (git-diff mode not requested).",
      );
      delete document.changeTracking.diff;
    }
    if (
      !ct?.modes?.includes("json") &&
      document.changeTracking.json !== undefined
    ) {
      meta.logger.warn(
        "Removed json from changeTracking (json mode not requested).",
      );
      delete document.changeTracking.json;
    }
  }

  const hasActions = (meta.options.actions?.length ?? 0) > 0;
  if (!hasActions) {
    delete document.actions;
  } else if (document.actions) {
    const a = document.actions;
    const anyContent =
      (a.screenshots?.length ?? 0) > 0 ||
      (a.scrapes?.length ?? 0) > 0 ||
      (a.javascriptReturns?.length ?? 0) > 0 ||
      (a.pdfs?.length ?? 0) > 0;
    if (!anyContent) delete document.actions;
  }

  return document;
}
