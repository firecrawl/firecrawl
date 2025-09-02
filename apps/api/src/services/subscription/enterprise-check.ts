import { supabase_service } from "../supabase";

interface SubscriptionResponse {
  prices: {
    products: {
      is_enterprise: boolean;
    };
  };
}

const RATE_LIMIT_CHANGE_NOTIFICATION_START_DATE = new Date("2025-03-12");

export async function isEnterpriseTeamCreatedAfterRateLimitChange(
  team_id: string,
): Promise<boolean> {
  const { data, error } = (await supabase_service
    .from("subscriptions")
    .select("prices(products(is_enterprise))")
    .eq("status", "active")
    .eq("team_id", team_id)
    .gt(
      "created",
      RATE_LIMIT_CHANGE_NOTIFICATION_START_DATE.toISOString(),
    )) as {
    data: SubscriptionResponse[] | null;
    error: any;
  };

  if (error || !data) {
    // If there's an error or no subscription found, assume non-enterprise
    return false;
  }

  const isEnterprise = data.find(
    sub => sub.prices?.products?.is_enterprise === true,
  );

  return !!isEnterprise;
}
