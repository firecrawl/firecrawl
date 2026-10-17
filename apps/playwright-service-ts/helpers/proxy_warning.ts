export interface ProxyWarningOptions {
  proxyServer?: string | null;
  warnNoProxy?: string | null;
  silenceProxyWarning?: string | null;
  warnFn?: (message: string) => void;
}

export const NO_PROXY_WARNING_MESSAGE =
  "⚠️ WARNING: No proxy server provided. Your IP address may be blocked.";

export function shouldWarnNoProxy(
  proxyServer?: string | null,
  warnNoProxyEnv?: string | null,
  silenceProxyWarningEnv?: string | null,
): boolean {
  if (proxyServer) {
    return false;
  }
  const warnNoProxy = (warnNoProxyEnv ?? "True").toUpperCase() !== "FALSE";
  const silenceNormalized = (silenceProxyWarningEnv ?? "False").toUpperCase();
  const silenceProxyWarning =
    silenceNormalized === "TRUE" || silenceNormalized === "1";

  return warnNoProxy && !silenceProxyWarning;
}

export function createProxyWarningEmitter(options: ProxyWarningOptions = {}) {
  let hasWarned = false;

  return function emitProxyWarningOnce(): boolean {
    if (hasWarned) {
      return false;
    }
    const shouldWarn = shouldWarnNoProxy(
      options.proxyServer !== undefined
        ? options.proxyServer
        : process.env.PROXY_SERVER,
      options.warnNoProxy !== undefined
        ? options.warnNoProxy
        : process.env.WARN_NO_PROXY,
      options.silenceProxyWarning !== undefined
        ? options.silenceProxyWarning
        : process.env.SILENCE_PROXY_WARNING,
    );
    if (shouldWarn) {
      hasWarned = true;
      const warn = options.warnFn ?? console.warn;
      warn(NO_PROXY_WARNING_MESSAGE);
      return true;
    }
    return false;
  };
}
