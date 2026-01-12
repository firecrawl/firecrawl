import { logger } from "../../lib/logger";
import { getRedisConnection } from "../queue-service";
import { setCachedACUC } from "../../controllers/auth";
import { AuthCreditUsageChunk } from "../../controllers/v1/types";
import { v7 as uuidv7 } from "uuid";
import * as Sentry from "@sentry/node";

// Reservation TTL - auto-expire after 30 minutes (in case of crashes)
const RESERVATION_TTL_SECONDS = 30 * 60;

// Redis key prefixes
const RESERVATION_KEY_PREFIX = "credit_reservation:";
const TEAM_RESERVATIONS_KEY_PREFIX = "team_reservations:";

export interface CreditReservation {
  id: string;
  team_id: string;
  api_key: string;
  credits: number;
  is_extract: boolean;
  created_at: number;
  finalized: boolean;
}

/**
 * Reserve credits atomically at request start.
 * This immediately decrements the cached credit balance to prevent
 * concurrent requests from exceeding limits.
 *
 * @param api_key - The API key string (for cache key)
 * @param team_id - The team ID
 * @param credits - Number of credits to reserve
 * @param is_extract - Whether this is an extract operation
 * @returns Reservation object with ID, or null if reservation failed
 */
export async function reserveCredits(
  api_key: string,
  team_id: string,
  credits: number,
  is_extract: boolean,
): Promise<CreditReservation | null> {
  const reservationId = uuidv7();
  const redis = getRedisConnection();

  try {
    const reservation: CreditReservation = {
      id: reservationId,
      team_id,
      api_key,
      credits,
      is_extract,
      created_at: Date.now(),
      finalized: false,
    };

    // Store reservation in Redis with TTL
    const reservationKey = `${RESERVATION_KEY_PREFIX}${reservationId}`;
    await redis.setex(
      reservationKey,
      RESERVATION_TTL_SECONDS,
      JSON.stringify(reservation),
    );

    // Add to team's active reservations set
    const teamReservationsKey = `${TEAM_RESERVATIONS_KEY_PREFIX}${team_id}`;
    await redis.sadd(teamReservationsKey, reservationId);
    await redis.expire(teamReservationsKey, RESERVATION_TTL_SECONDS);

    // Atomically update the cached ACUC to reflect reserved credits
    // This is the key operation that prevents the race condition
    await setCachedACUC(
      api_key,
      is_extract,
      (acuc: AuthCreditUsageChunk | null) =>
        acuc
          ? {
              ...acuc,
              // Increase credits_used to reflect the reservation
              credits_used: acuc.credits_used + credits,
              adjusted_credits_used: acuc.adjusted_credits_used + credits,
              remaining_credits: acuc.remaining_credits - credits,
            }
          : null,
    );

    logger.debug("Reserved credits", {
      reservationId,
      team_id,
      credits,
      is_extract,
    });

    return reservation;
  } catch (error) {
    logger.error("Failed to reserve credits", {
      error,
      team_id,
      credits,
      reservationId,
    });
    Sentry.captureException(error, {
      data: { operation: "reserve_credits", team_id, credits },
    });
    return null;
  }
}

/**
 * Finalize a reservation when billing completes.
 * Adjusts for the difference between reserved and actual credits.
 *
 * @param reservationId - The reservation ID from reserveCredits
 * @param actualCredits - The actual credits used (may differ from reserved)
 * @returns Success status
 */
export async function finalizeReservation(
  reservationId: string,
  actualCredits: number,
): Promise<{ success: boolean; error?: string }> {
  const redis = getRedisConnection();
  const reservationKey = `${RESERVATION_KEY_PREFIX}${reservationId}`;

  try {
    const reservationData = await redis.get(reservationKey);
    if (!reservationData) {
      // Reservation may have expired or already been finalized
      logger.warn("Reservation not found for finalization", { reservationId });
      return { success: true }; // Not an error - billing will proceed normally
    }

    const reservation: CreditReservation = JSON.parse(reservationData);

    if (reservation.finalized) {
      logger.warn("Reservation already finalized", { reservationId });
      return { success: true };
    }

    const creditDifference = actualCredits - reservation.credits;

    // If actual credits differ from reserved, adjust the cache
    if (creditDifference !== 0) {
      await setCachedACUC(
        reservation.api_key,
        reservation.is_extract,
        (acuc: AuthCreditUsageChunk | null) =>
          acuc
            ? {
                ...acuc,
                credits_used: acuc.credits_used + creditDifference,
                adjusted_credits_used:
                  acuc.adjusted_credits_used + creditDifference,
                remaining_credits: acuc.remaining_credits - creditDifference,
              }
            : null,
      );

      logger.debug("Adjusted reservation credits", {
        reservationId,
        reserved: reservation.credits,
        actual: actualCredits,
        difference: creditDifference,
      });
    }

    // Mark as finalized
    reservation.finalized = true;
    await redis.setex(
      reservationKey,
      60, // Keep for 1 minute after finalization for debugging
      JSON.stringify(reservation),
    );

    // Remove from team's active reservations
    const teamReservationsKey = `${TEAM_RESERVATIONS_KEY_PREFIX}${reservation.team_id}`;
    await redis.srem(teamReservationsKey, reservationId);

    logger.debug("Finalized reservation", {
      reservationId,
      actualCredits,
      team_id: reservation.team_id,
    });

    return { success: true };
  } catch (error) {
    logger.error("Failed to finalize reservation", {
      error,
      reservationId,
      actualCredits,
    });
    Sentry.captureException(error, {
      data: { operation: "finalize_reservation", reservationId, actualCredits },
    });
    return { success: false, error: String(error) };
  }
}

/**
 * Release a reservation (refund credits) when a request fails.
 * This restores the credits that were reserved.
 *
 * @param reservationId - The reservation ID to release
 * @returns Success status
 */
export async function releaseReservation(
  reservationId: string,
): Promise<{ success: boolean; error?: string }> {
  const redis = getRedisConnection();
  const reservationKey = `${RESERVATION_KEY_PREFIX}${reservationId}`;

  try {
    const reservationData = await redis.get(reservationKey);
    if (!reservationData) {
      logger.warn("Reservation not found for release", { reservationId });
      return { success: true };
    }

    const reservation: CreditReservation = JSON.parse(reservationData);

    if (reservation.finalized) {
      logger.warn("Cannot release finalized reservation", { reservationId });
      return { success: false, error: "Reservation already finalized" };
    }

    // Restore the reserved credits to the cache
    await setCachedACUC(
      reservation.api_key,
      reservation.is_extract,
      (acuc: AuthCreditUsageChunk | null) =>
        acuc
          ? {
              ...acuc,
              credits_used: acuc.credits_used - reservation.credits,
              adjusted_credits_used:
                acuc.adjusted_credits_used - reservation.credits,
              remaining_credits: acuc.remaining_credits + reservation.credits,
            }
          : null,
    );

    // Remove the reservation
    await redis.del(reservationKey);

    // Remove from team's active reservations
    const teamReservationsKey = `${TEAM_RESERVATIONS_KEY_PREFIX}${reservation.team_id}`;
    await redis.srem(teamReservationsKey, reservationId);

    logger.info("Released reservation", {
      reservationId,
      credits: reservation.credits,
      team_id: reservation.team_id,
    });

    return { success: true };
  } catch (error) {
    logger.error("Failed to release reservation", { error, reservationId });
    Sentry.captureException(error, {
      data: { operation: "release_reservation", reservationId },
    });
    return { success: false, error: String(error) };
  }
}

/**
 * Get active reservations for a team (for debugging/monitoring).
 */
export async function getTeamReservations(
  team_id: string,
): Promise<CreditReservation[]> {
  const redis = getRedisConnection();
  const teamReservationsKey = `${TEAM_RESERVATIONS_KEY_PREFIX}${team_id}`;

  try {
    const reservationIds = await redis.smembers(teamReservationsKey);
    const reservations: CreditReservation[] = [];

    for (const id of reservationIds) {
      const data = await redis.get(`${RESERVATION_KEY_PREFIX}${id}`);
      if (data) {
        reservations.push(JSON.parse(data));
      }
    }

    return reservations;
  } catch (error) {
    logger.error("Failed to get team reservations", { error, team_id });
    return [];
  }
}
