type ProxyRetryMeta = {
  options: {
    proxy?: unknown;
  };
  featureFlags: Set<string>;
};

const CHROME_PROXY_ERROR_CODES = [
  "ERR_TUNNEL_CONNECTION_FAILED",
  "ERR_PROXY_CONNECTION_FAILED",
];

export function shouldRetryChromeProxyErrorWithStealth(
  errorCode: string,
  meta: ProxyRetryMeta,
) {
  return (
    meta.options.proxy === "auto" &&
    !meta.featureFlags.has("stealthProxy") &&
    CHROME_PROXY_ERROR_CODES.some(code => errorCode.includes(code))
  );
}
