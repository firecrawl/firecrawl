import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { logger } from "../../lib/logger";
import { configDotenv } from "dotenv";
configDotenv();

// SupabaseLedgerService class initializes the Supabase client for the ledger schema
class SupabaseLedgerService {
  private client: SupabaseClient<any, "ledger", any> | null = null;
  private rrClient: SupabaseClient<any, "ledger", any> | null = null;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseReplicaUrl = process.env.SUPABASE_REPLICA_URL;
    const supabaseServiceToken = process.env.SUPABASE_SERVICE_TOKEN;
    const useDbAuthentication = process.env.USE_DB_AUTHENTICATION === "true";
    
    // Only initialize the Supabase client if both URL and Service Token are provided.
    if (!useDbAuthentication) {
      // Warn the user that Authentication is disabled by setting the client to null
      logger.warn(
        "Authentication is disabled. Supabase ledger client will not be initialized.",
      );
      this.client = null;
    } else if (!supabaseUrl || !supabaseServiceToken || !supabaseReplicaUrl) {
      logger.error(
        "Supabase environment variables aren't configured correctly. Supabase ledger client will not be initialized. Fix ENV configuration or disable DB authentication with USE_DB_AUTHENTICATION env variable",
      );
    } else {
      this.client = createClient(supabaseUrl, supabaseServiceToken, {
        global: {
          headers: {
            "sb-lb-routing-mode": "alpha-all-services",
          },
        },
        db: {
          //@ts-ignore
          schema: "ledger",
        },
      });

      this.rrClient = createClient(supabaseReplicaUrl, supabaseServiceToken, {
        db: {
          //@ts-ignore
          schema: "ledger",
        },
      });
    }
  }

  // Provides access to the initialized Supabase client, if available.
  getClient(): SupabaseClient<any, "ledger", any> | null {
    return this.client;
  }

  getRRClient(): SupabaseClient<any, "ledger", any> | null {
    return this.rrClient;
  }
}

const ledgerServ = new SupabaseLedgerService();

// Using a Proxy to handle dynamic access to the Supabase ledger client or service methods.
// This approach ensures that if Supabase is not configured, any attempt to use it will result in a clear error.
export const supabase_ledger_service: SupabaseClient<any, "ledger", any> = new Proxy(
  ledgerServ,
  {
    get: function (target, prop, receiver) {
      const client = target.getClient();
      // If the Supabase client is not initialized, intercept property access to provide meaningful error feedback.
      if (client === null) {
        return () => {
          throw new Error("Supabase ledger client is not configured.");
        };
      }
      // Direct access to SupabaseLedgerService properties takes precedence.
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }
      // Otherwise, delegate access to the Supabase client.
      return Reflect.get(client, prop, receiver);
    },
  },
) as unknown as SupabaseClient<any, "ledger", any>;