/** Keep the legacy webhook flag working for existing self-hosted deployments. */
export function allowPrivateScraping(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.ALLOW_PRIVATE_IP_SCRAPING?.toUpperCase() === 'TRUE' ||
    env.ALLOW_LOCAL_WEBHOOKS?.toUpperCase() === 'TRUE'
  );
}
