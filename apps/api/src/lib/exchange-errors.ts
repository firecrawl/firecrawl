import { type ErrorCode, TransportableError } from "./error";

export type ExchangeTerms = {
  key: string;
  version: string;
};

const DEFAULT_DASHBOARD_URL = "https://www.firecrawl.dev";

let readDashboardUrl: () => string | undefined = () =>
  process.env.FIRECRAWL_DASHBOARD_URL;

/**
 * Registers the dashboard URL reader once runtime config is loaded, keeping
 * this module free of config import side effects.
 */
export function setDashboardUrlReader(reader: () => string | undefined): void {
  readDashboardUrl = reader;
}

function getDashboardBaseUrl(): string {
  return (readDashboardUrl() || DEFAULT_DASHBOARD_URL).replace(/\/+$/, "");
}

// Terms are keyed by provider id, so the key doubles as the provider page to accept them on.
function getThirdPartyDataTermsUrl(terms: ExchangeTerms): string {
  return `${getDashboardBaseUrl()}/app/alexandria/${encodeURIComponent(terms.key)}`;
}

export function getEnrichmentSettingsUrl(): string {
  return `${getDashboardBaseUrl()}/app/alexandria?enrichment=true`;
}

/**
 * An organization admin has to accept a provider's terms before the request
 * can run. Transportable, so it crosses the worker queue intact; every
 * surface that reports it sends `response()`, or `requiresAction` alone where
 * the error is one entry of a list.
 */
export class ThirdPartyDataTermsRequiredError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "THIRD_PARTY_DATA_TERMS_REQUIRED",
  ];

  public readonly terms: ExchangeTerms;
  /** Set when the provider is a step in the team's enrichment order, which can drop it instead. */
  public readonly enrichment: boolean;

  constructor(terms: ExchangeTerms, options: { enrichment?: boolean } = {}) {
    const accept = `An organization admin must accept the ${terms.key} provider's terms (version ${terms.version}) before this request can run. Accept them at ${getThirdPartyDataTermsUrl(terms)}`;
    super(
      "THIRD_PARTY_DATA_TERMS_REQUIRED",
      options.enrichment
        ? `${accept}, or turn off ${terms.key} in ${getEnrichmentSettingsUrl()}.`
        : accept,
    );
    this.name = "ThirdPartyDataTermsRequiredError";
    this.terms = { key: terms.key, version: terms.version };
    this.enrichment = options.enrichment === true;
  }

  get endsEngineLoop(): boolean {
    return true;
  }

  get httpStatus(): number {
    return 403;
  }

  get httpResponseFields(): Record<string, unknown> {
    return {
      requiresAction: this.requiresAction,
    };
  }

  get requiresAction() {
    return {
      type: "accept_terms" as const,
      terms: this.terms.key,
      version: this.terms.version,
      url: getThirdPartyDataTermsUrl(this.terms),
    };
  }

  response() {
    return {
      success: false as const,
      code: "THIRD_PARTY_DATA_TERMS_REQUIRED" as const,
      error: this.message,
      requiresAction: this.requiresAction,
    };
  }

  serialize() {
    return {
      ...super.serialize(),
      terms: this.terms,
      enrichment: this.enrichment,
    };
  }

  static deserialize(
    _code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ThirdPartyDataTermsRequiredError(data.terms, {
      enrichment: data.enrichment,
    });
    x.stack = data.stack;
    return x;
  }
}

/**
 * A provider serves the URL and nothing else may, but the request uses an
 * option the provider's data can't honor.
 */
export class ThirdPartyDataUnsupportedOptionError extends TransportableError {
  static readonly codes: readonly ErrorCode[] = [
    "THIRD_PARTY_DATA_UNSUPPORTED_OPTION",
  ];

  public readonly option: string;

  constructor(option: string) {
    super(
      "THIRD_PARTY_DATA_UNSUPPORTED_OPTION",
      `A third-party data provider serves this URL, but not to requests that use ${option}.`,
    );
    this.name = "ThirdPartyDataUnsupportedOptionError";
    this.option = option;
  }

  get httpStatus(): number {
    return 400;
  }

  response() {
    return {
      success: false as const,
      code: "THIRD_PARTY_DATA_UNSUPPORTED_OPTION" as const,
      error: this.message,
    };
  }

  serialize() {
    return {
      ...super.serialize(),
      option: this.option,
    };
  }

  static deserialize(
    _code: ErrorCode,
    data: ReturnType<typeof this.prototype.serialize>,
  ) {
    const x = new ThirdPartyDataUnsupportedOptionError(data.option);
    x.stack = data.stack;
    return x;
  }
}
