type OAuthCacheInvalidationConfig = {
  OAUTH_CACHE_INVALIDATION_ENABLED?: boolean;
  USE_DB_AUTHENTICATION?: boolean;
};

export function getOAuthCacheInvalidationConfigErrors(
  config: OAuthCacheInvalidationConfig,
) {
  if (
    config.OAUTH_CACHE_INVALIDATION_ENABLED === true &&
    config.USE_DB_AUTHENTICATION !== true
  ) {
    return [
      {
        path: "OAUTH_CACHE_INVALIDATION_ENABLED" as const,
        message: "OAuth cache invalidation requires USE_DB_AUTHENTICATION=true",
      },
    ];
  }
  return [];
}
