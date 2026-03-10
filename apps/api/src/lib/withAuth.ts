import { AuthResponse } from "../../src/types";
import { logger } from "./logger";
import * as Sentry from "@sentry/node";
import { configDotenv } from "dotenv";
import { config } from "../config";
configDotenv();

let warningCount = 0;

export function withAuth<T, U extends any[]>(
  originalFunction: (...args: U) => Promise<T>,
  mockSuccess: T,
) {
  return async function (...args: U): Promise<T> {
    const useDbAuthentication = config.USE_DB_AUTHENTICATION;
    if (!useDbAuthentication) {
      if (warningCount < 5) {
        logger.warn("You're bypassing authentication");
        warningCount++;
      }
      return { success: true, ...(mockSuccess || {}) } as T;
    } else {
      return await originalFunction(...args);
    }
  };
}
