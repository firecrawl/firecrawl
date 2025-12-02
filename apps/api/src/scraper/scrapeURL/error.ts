import { ErrorCodes, TransportableError } from "../../lib/error";
import { Meta } from ".";
import { Engine, FeatureFlag } from "./engines";
import { isSelfHosted } from "../../lib/deployment";

export class EngineError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class NoEnginesLeftError extends TransportableError {
  public fallbackList: Engine[];

  constructor(fallbackList: Engine[]) {
    const message = isSelfHosted()
      ? "All scraping engines failed! -- Double check the URL to make sure it's not broken. Check your server logs for more details."
      : "All scraping engines failed! -- Double check the URL to make sure it's not broken. If the issue persists, contact us at help@firecrawl.com.";

    super("SCRAPE_ALL_ENGINES_FAILED", message);
    this.fallbackList = fallbackList;
  }

  serialize() {
    return {
      ...super.serialize(),
      fallbackList: this.fallbackList,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new NoEnginesLeftError(data.fallbackList);
    x.stack = data.stack;
    return x;
  }
}

export class AddFeatureError extends Error {
  public featureFlags: FeatureFlag[];
  public pdfPrefetch: Meta["pdfPrefetch"];
  public documentPrefetch: Meta["documentPrefetch"];

  constructor(
    featureFlags: FeatureFlag[],
    pdfPrefetch?: Meta["pdfPrefetch"],
    documentPrefetch?: Meta["documentPrefetch"],
  ) {
    super("New feature flags have been discovered: " + featureFlags.join(", "));
    this.featureFlags = featureFlags;
    this.pdfPrefetch = pdfPrefetch;
    this.documentPrefetch = documentPrefetch;
  }
}

export class RemoveFeatureError extends Error {
  public featureFlags: FeatureFlag[];

  constructor(featureFlags: FeatureFlag[]) {
    super(
      "Incorrect feature flags have been discovered: " +
        featureFlags.join(", "),
    );
    this.featureFlags = featureFlags;
  }
}

export class SSLError extends TransportableError {
  constructor(public skipTlsVerification: boolean) {
    super(
      "SCRAPE_SSL_ERROR",
      "An SSL error occurred while scraping the URL. " +
        (skipTlsVerification
          ? "Since you have `skipTlsVerification` enabled, this means that the TLS configuration of the target site is completely broken. Try scraping the plain HTTP version of the page."
          : "If you're not inputting any sensitive data, try scraping with `skipTlsVerification: true`."),
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      skipTlsVerification: this.skipTlsVerification,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SSLError(data.skipTlsVerification);
    x.stack = data.stack;
    return x;
  }
}

export class SiteError extends TransportableError {
  constructor(public errorCode: string) {
    super(
      "SCRAPE_SITE_ERROR",
      "Specified URL is failing to load in the browser. Error code: " +
        errorCode,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      errorCode: this.errorCode,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new SiteError(data.errorCode);
    x.stack = data.stack;
    return x;
  }
}

export class ProxySelectionError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_PROXY_SELECTION_ERROR",
      "Specified proxy cannot be selected. Change `location` or `proxy` in your scrape request.",
    );
  }

  serialize() {
    return {
      ...super.serialize(),
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ProxySelectionError();
    x.stack = data.stack;
    return x;
  }
}

export class ActionError extends TransportableError {
  constructor(public errorCode: string) {
    super(
      "SCRAPE_ACTION_ERROR",
      "Action(s) failed to complete. Error code: " + errorCode,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      errorCode: this.errorCode,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ActionError(data.errorCode);
    x.stack = data.stack;
    return x;
  }
}

export class UnsupportedFileError extends TransportableError {
  constructor(public reason: string) {
    super(
      "SCRAPE_UNSUPPORTED_FILE_ERROR",
      "Scrape resulted in unsupported file: " + reason,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      reason: this.reason,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new UnsupportedFileError(data.reason);
    x.stack = data.stack;
    return x;
  }
}

export class PDFAntibotError extends TransportableError {
  constructor() {
    super("SCRAPE_PDF_ANTIBOT_ERROR", "PDF scrape was prevented by anti-bot");
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFAntibotError();
    x.stack = data.stack;
    return x;
  }
}

export class PDFInsufficientTimeError extends TransportableError {
  constructor(
    public pageCount: number,
    public minTimeout: number,
  ) {
    super(
      "SCRAPE_PDF_INSUFFICIENT_TIME_ERROR",
      `Insufficient time to process PDF of ${pageCount} pages. Please increase the timeout parameter in your scrape request to at least ${minTimeout}ms.`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      pageCount: this.pageCount,
      minTimeout: this.minTimeout,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFInsufficientTimeError(data.pageCount, data.minTimeout);
    x.stack = data.stack;
    return x;
  }
}

export class DNSResolutionError extends TransportableError {
  constructor(public hostname: string) {
    super(
      "SCRAPE_DNS_RESOLUTION_ERROR",
      `DNS resolution failed for hostname: ${hostname}. Please check if the domain is valid and accessible.`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      hostname: this.hostname,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DNSResolutionError(data.hostname);
    x.stack = data.stack;
    return x;
  }
}

export class IndexMissError extends Error {
  constructor() {
    super("Index doesn't have the page we're looking for");
  }
}

export class NoCachedDataError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_NO_CACHED_DATA",
      "No cached data available that meets the specified age requirements.",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new NoCachedDataError();
    x.stack = data.stack;
    return x;
  }
}

export class ZDRViolationError extends TransportableError {
  constructor(public feature: string) {
    super(
      "SCRAPE_ZDR_VIOLATION_ERROR",
      `${feature} is not supported when using zeroDataRetention. Please contact support@firecrawl.com to unblock this feature.`,
    );
  }

  serialize() {
    return {
      ...super.serialize(),
      feature: this.feature,
    };
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ZDRViolationError(data.feature);
    x.stack = data.stack;
    return x;
  }
}

export class PDFPrefetchFailed extends TransportableError {
  constructor() {
    const message = isSelfHosted()
      ? "Failed to prefetch PDF that is protected by anti-bot. Please check your logs for more details."
      : "Failed to prefetch PDF that is protected by anti-bot. Please contact help@firecrawl.com";

    super("SCRAPE_PDF_PREFETCH_FAILED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new PDFPrefetchFailed();
    x.stack = data.stack;
    return x;
  }
}

export class DocumentAntibotError extends TransportableError {
  constructor() {
    super(
      "SCRAPE_DOCUMENT_ANTIBOT_ERROR",
      "Document scrape was prevented by anti-bot",
    );
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DocumentAntibotError();
    x.stack = data.stack;
    return x;
  }
}

export class DocumentPrefetchFailed extends TransportableError {
  constructor() {
    const message = isSelfHosted()
      ? "Failed to prefetch document that is protected by anti-bot. Please check your logs for more details."
      : "Failed to prefetch document that is protected by anti-bot. Please contact help@firecrawl.com";

    super("SCRAPE_DOCUMENT_PREFETCH_FAILED", message);
  }

  serialize() {
    return super.serialize();
  }

  static deserialize(
    _: ErrorCodes,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new DocumentPrefetchFailed();
    x.stack = data.stack;
    return x;
  }
}

export class FEPageLoadFailed extends Error {
  constructor() {
    super(
      "The page failed to load with the specified timeout. Please increase the timeout parameter in your request.",
    );
  }
}

export class EngineSnipedError extends Error {
  name = "EngineSnipedError";

  constructor() {
    super("Engine got sniped");
  }
}

export class EngineUnsuccessfulError extends Error {
  name = "EngineUnsuccessfulError";

  constructor(engine: Engine) {
    super(`Engine ${engine} was unsuccessful`);
  }
}

export class WaterfallNextEngineSignal extends Error {
  name = "WaterfallNextEngineSignal";

  constructor() {
    super("Waterfall next engine");
  }
}
