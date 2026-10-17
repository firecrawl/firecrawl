/** Keep the legacy webhook flag working for existing self-hosted deployments. */
export function allowPrivateScraping(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const enabled = (value: string | undefined) =>
    /^(true|1|yes|on|y|enabled)$/i.test(value ?? '');
  return (
    enabled(env.ALLOW_PRIVATE_IP_SCRAPING) ||
    enabled(env.ALLOW_LOCAL_WEBHOOKS)
  );
}
