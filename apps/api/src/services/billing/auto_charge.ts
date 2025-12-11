// Import necessary dependencies and types
import { AuthCreditUsageChunk } from "../../controllers/v1/types";
import { config } from "../../config";
import { clearACUC, clearACUCTeam, getACUC } from "../../controllers/auth";
import { redlock } from "../redlock";
import { supabase_rr_service, supabase_service } from "../supabase";
import {
  createPaymentIntent,
  createSubscription,
  customerToUserId,
} from "./stripe";
import { issueCredits } from "./issue_credits";
import {
  sendNotification,
  sendNotificationWithCustomDays,
} from "../notification/email_notification";
import { NotificationType } from "../../types";
import { deleteKey, getValue, redisEvictConnection, setValue } from "../redis";
import { redisRateLimitClient } from "../rate-limiter";
import { sendSlackWebhook } from "../alerts/slack";
import { logger as _logger } from "../../lib/logger";

// Define the number of credits to be added during auto-recharge
const AUTO_RECHARGE_CREDITS = 1000;
const AUTO_RECHARGE_COOLDOWN = 600; // 10 minutes in seconds
const MAX_CHARGES_PER_HOUR = 5; // Maximum number of auto-charges per hour
const HOURLY_COUNTER_EXPIRY = 3600; // 1 hour in seconds

// Type definition for auto-charge response
type AutoChargeResponse = {
  success: boolean;
  message: string;
  remainingCredits: number;
  chunk: AuthCreditUsageChunk;
};

/**
 * Attempt to automatically charge a user's account when their credit balance falls below a threshold
 * @param chunk The user's current usage data
 * @param autoRechargeThreshold The credit threshold that triggers auto-recharge
 */
export async function autoCharge(
  chunk: AuthCreditUsageChunk,
  autoRechargeThreshold: number,
): Promise<AutoChargeResponse> {
  if (chunk.price_associated_auto_recharge_price_id !== null) {
    return _autoChargeScale(
      chunk as AuthCreditUsageChunk & {
        price_associated_auto_recharge_price_id: string;
      },
      autoRechargeThreshold,
    );
  } else {
    return _autoChargeSelfServe(chunk, autoRechargeThreshold);
  }
}

async function _autoChargeScale(
  chunk: AuthCreditUsageChunk & {
    price_associated_auto_recharge_price_id: string;
  },
  autoRechargeThreshold: number,
): Promise<AutoChargeResponse> {
  const logger = _logger.child({
    module: "auto_charge",
    method: "_autoChargeScale",
    team_id: chunk.team_id,
    teamId: chunk.team_id,
  });

  logger.info("Scale auto-recharge triggered", {});

  const resource = `auto-recharge:${chunk.team_id}`;

  try {
    return await redlock.using(
      [resource],
      15000,
      async (signal: unknown): Promise<AutoChargeResponse> => {
        logger.info("Lock acquired");

        const cooldownCheck = await redisEvictConnection.set(
          "auto-recharge-cooldown:" + chunk.team_id,
          "cooling",
          "EX",
          AUTO_RECHARGE_COOLDOWN,
          "NX",
        );

        if (cooldownCheck === null) {
          logger.warn("Auto-recharge is on cooldown, aborting.");
          return {
            success: false,
            message: "Auto-recharge is on cooldown",
            remainingCredits: chunk.remaining_credits,
            chunk,
          };
        }

        const updatedChunk = await getACUC(chunk.api_key, false, false);

        if (
          updatedChunk &&
          updatedChunk.remaining_credits < autoRechargeThreshold
        ) {
          const { data: price, error: priceError } = await supabase_service
            .from("prices")
            .select("*")
            .eq("id", chunk.price_associated_auto_recharge_price_id)
            .single();
          if (priceError || !price) {
            logger.error("Error fetching price", {
              error: priceError,
              priceId:
                chunk.price_associated_auto_recharge_price_id === undefined
                  ? "undefined"
                  : JSON.stringify(
                    chunk.price_associated_auto_recharge_price_id,
                  ),
            });
            return {
              success: false,
              message: "Error fetching price",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          }

          const invoiceOnly = Boolean(
            (price.metadata as { invoice?: boolean } | null | undefined)
              ?.invoice,
          );

          // Check for recharges this month

          const currentMonth = new Date();
          currentMonth.setUTCDate(1);
          currentMonth.setUTCHours(0, 0, 0, 0);

          const { data: rechargesThisMonth, error: rechargesThisMonthError } =
            await supabase_service
              .from("subscriptions")
              .select("*")
              .eq("team_id", chunk.team_id)
              .eq("metadata->>auto_recharge", "true")
              .gte("current_period_start", currentMonth.toISOString());

          if (rechargesThisMonthError || !rechargesThisMonth) {
            logger.error("Error fetching recharges this month", {
              error: rechargesThisMonthError,
            });
            return {
              success: false,
              message: "Error fetching recharges this month",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          } else if (
            rechargesThisMonth.length >= (price.exp_pack_max_per_month ?? 4)
          ) {
            logger.warn("Auto-recharge failed: too many recharges this month");
            return {
              success: false,
              message: "Auto-recharge failed: too many recharges this month",
              remainingCredits:
                updatedChunk?.remaining_credits ?? chunk.remaining_credits,
              chunk: updatedChunk ?? chunk,
            };
          } else {
            // Actually re-charge

            if (!chunk.sub_user_id) {
              logger.error("No sub_user_id found in chunk");
              return {
                success: false,
                message: "No sub_user_id found in chunk",
                remainingCredits:
                  updatedChunk?.remaining_credits ?? chunk.remaining_credits,
                chunk: updatedChunk ?? chunk,
              };
            }

            const { data: customer, error: customersError } =
              await supabase_rr_service
                .from("customers")
                .select("id, stripe_customer_id")
                .eq("id", chunk.sub_user_id)
                .single();

            if (customersError || !customer) {
              logger.error("Error fetching customer data", {
                error: customersError,
              });
              return {
                success: false,
                message: "Error fetching customer data",
                remainingCredits:
                  updatedChunk?.remaining_credits ?? chunk.remaining_credits,
                chunk: updatedChunk ?? chunk,
              };
            }

            if (!customer.stripe_customer_id) {
              logger.error("No stripe_customer_id found in customer");
              return {
                success: false,
                message: "No stripe_customer_id found in customer",
                remainingCredits:
                  updatedChunk?.remaining_credits ?? chunk.remaining_credits,
                chunk: updatedChunk ?? chunk,
              };
            }

            if (!chunk.sub_id) {
              logger.error("No sub_id found in chunk");
              return {
                success: false,
                message: "No sub_id found in chunk",
                remainingCredits:
                  updatedChunk?.remaining_credits ?? chunk.remaining_credits,
                chunk: updatedChunk ?? chunk,
              };
            }

            const subscription = await createSubscription(
              chunk.team_id,
              customer.stripe_customer_id,
              chunk.price_associated_auto_recharge_price_id,
              chunk.sub_id,
              invoiceOnly,
            );
            if (!subscription) {
              logger.error("Failed to create subscription");
              return {
                success: false,
                message: "Failed to create subscription",
                remainingCredits:
                  updatedChunk?.remaining_credits ?? chunk.remaining_credits,
                chunk: updatedChunk ?? chunk,
              };
            }

            const userId = await customerToUserId(customer.stripe_customer_id);
            if (!userId) {
              logger.error("Failed to get user id from customer");
              return {
                success: false,
                message: "Failed to get user id from customer",
                remainingCredits:
                  updatedChunk?.remaining_credits ?? chunk.remaining_credits,
                chunk: updatedChunk ?? chunk,
              };
            }

            // Try to insert it into subscriptions ourselves in case webhook is slow
            const { error: subscriptionError } = await supabase_service
              .from("subscriptions")
              .insert({
                id: subscription.id,
                user_id: userId,
                metadata: subscription.metadata,
                status: subscription.status,
                price_id: chunk.price_associated_auto_recharge_price_id,
                quantity: 1,
                cancel_at_period_end: false,
                cancel_at: null,
                canceled_at: null,
                current_period_start: subscription.current_period_start
                  ? new Date(
                    subscription.current_period_start * 1000,
                  ).toISOString()
                  : null,
                current_period_end: subscription.current_period_end
                  ? new Date(
                    subscription.current_period_end * 1000,
                  ).toISOString()
                  : null,
                created: subscription.created
                  ? new Date(subscription.created * 1000).toISOString()
                  : null,
                ended_at: null,
                trial_start: null,
                trial_end: null,
                team_id: chunk.team_id,
                is_extract: false,
              });

            if (subscriptionError) {
              logger.warn(
                "Failed to add subscription to supabase -- maybe we got sniped by the webhook?",
                { error: subscriptionError },
              );
            }

            // Reset ACUC cache to reflect the new credit balance
            await clearACUC(chunk.api_key);
            await clearACUCTeam(chunk.team_id);

            try {
              // Check for frequent auto-recharges in the past week
              const weeklyAutoRechargeKey = `auto-recharge-weekly:${chunk.team_id}`;
              const weeklyRecharges = await redisRateLimitClient.incr(
                weeklyAutoRechargeKey,
              );
              // Set expiry for 7 days if not already set
              await redisRateLimitClient.expire(
                weeklyAutoRechargeKey,
                7 * 24 * 60 * 60,
              );

              // If this is the second auto-recharge in a week, send notification
              if (weeklyRecharges >= 2) {
                await sendNotificationWithCustomDays(
                  chunk.team_id,
                  NotificationType.AUTO_RECHARGE_FREQUENT,
                  7, // Send at most once per week
                  false,
                );
              }
            } catch (error) {
              logger.error(
                `Error sending frequent auto-recharge notification`,
                {
                  error,
                },
              );
            }

            await sendNotification(
              chunk.team_id,
              NotificationType.AUTO_RECHARGE_SUCCESS,
              chunk.sub_current_period_start,
              chunk.sub_current_period_end,
              chunk,
              true,
              false,
              { autoRechargeCredits: price.credits },
            );

            logger.info("Scale auto-recharge successful");

            if (config.SLACK_ADMIN_WEBHOOK_URL) {
              sendSlackWebhook(
                `💰 Auto-recharge successful on team ${chunk.team_id} for ${price.credits} credits (total auto-recharges this month: ${rechargesThisMonth.length + 1}).`,
                false,
                config.SLACK_ADMIN_WEBHOOK_URL,
              ).catch(error => {
                logger.debug(`Error sending slack notification: ${error}`);
              });
            }

            return {
              success: true,
              message: "Auto-recharge successful",
              remainingCredits:
                (updatedChunk?.remaining_credits ?? chunk.remaining_credits) +
                price.credits,
              chunk: {
                ...(updatedChunk ?? chunk),
                remaining_credits:
                  (updatedChunk?.remaining_credits ?? chunk.remaining_credits) +
                  price.credits,
              },
            };
          }
        } else {
          return {
            success: false,
            message: "No need to auto-recharge",
            remainingCredits:
              updatedChunk?.remaining_credits ?? chunk.remaining_credits,
            chunk: updatedChunk ?? chunk,
          };
        }
      },
    );
  } catch (error) {
    logger.error("Auto-recharge failed", { error });
    return {
      success: false,
      message: "Failed to acquire lock for auto-recharge",
      remainingCredits: chunk.remaining_credits,
      chunk,
    };
  }
}

async function _autoChargeSelfServe(
  chunk: AuthCreditUsageChunk,
  autoRechargeThreshold: number,
): Promise<AutoChargeResponse> {
  const logger = _logger.child({
    module: "auto_charge",
    method: "_autoChargeSelfServe",
    team_id: chunk.team_id,
    teamId: chunk.team_id,
  });

  const resource = `auto-recharge:${chunk.team_id}`;
  const cooldownKey = `auto-recharge-cooldown:${chunk.team_id}`;
  const hourlyCounterKey = `auto-recharge-hourly:${chunk.team_id}`;

  if (
    chunk.team_id === "285bb597-6eaf-4b96-801c-51461fc3c543" ||
    chunk.team_id === "dec639a0-98ca-4995-95b5-48ac1ffab5b7"
  ) {
    return {
      success: false,
      message: "Auto-recharge failed: blocked team",
      remainingCredits: chunk.remaining_credits,
      chunk,
    };
  }

  try {
    // Check hourly rate limit first without incrementing
    const currentCharges = await redisRateLimitClient.get(hourlyCounterKey);
    const hourlyCharges = currentCharges ? parseInt(currentCharges) : 0;

    if (hourlyCharges >= MAX_CHARGES_PER_HOUR) {
      logger.warn(
        `Auto-recharge exceeded hourly limit of ${MAX_CHARGES_PER_HOUR}`,
      );
      return {
        success: false,
        message: "Auto-recharge hourly limit exceeded",
        remainingCredits: chunk.remaining_credits,
        chunk,
      };
    }

    // Check cooldown period
    const cooldownValue = await getValue(cooldownKey);
    if (cooldownValue) {
      logger.info(`Auto-recharge is in cooldown period`);
      return {
        success: false,
        message: "Auto-recharge is in cooldown period",
        remainingCredits: chunk.remaining_credits,
        chunk,
      };
    }

    // Use a distributed lock to prevent concurrent auto-charge attempts
    return await redlock.using(
      [resource],
      5000,
      async (signal: unknown): Promise<AutoChargeResponse> => {
        // Recheck all conditions inside the lock to prevent race conditions
        const updatedChunk = await getACUC(chunk.api_key, false, false);

        // Recheck cooldown
        const cooldownValue = await getValue(cooldownKey);
        if (cooldownValue) {
          logger.info(`Auto-recharge is in cooldown period`);
          return {
            success: false,
            message: "Auto-recharge is in cooldown period",
            remainingCredits: chunk.remaining_credits,
            chunk,
          };
        }

        // Recheck hourly limit inside lock
        const currentCharges = await redisRateLimitClient.get(hourlyCounterKey);
        const hourlyCharges = currentCharges ? parseInt(currentCharges) : 0;
        if (hourlyCharges >= MAX_CHARGES_PER_HOUR) {
          return {
            success: false,
            message: "Auto-recharge hourly limit exceeded",
            remainingCredits: chunk.remaining_credits,
            chunk,
          };
        }

        if (
          updatedChunk &&
          updatedChunk.remaining_credits < autoRechargeThreshold
        ) {
          if (chunk.sub_user_id) {
            // Fetch the customer's Stripe information
            const { data: customer, error: customersError } =
              await supabase_rr_service
                .from("customers")
                .select("id, stripe_customer_id")
                .eq("id", chunk.sub_user_id)
                .single();

            if (customersError) {
              logger.error(`Error fetching customer data`, {
                error: customersError,
              });
              return {
                success: false,
                message: "Error fetching customer data",
                remainingCredits: chunk.remaining_credits,
                chunk,
              };
            }

            if (customer && customer.stripe_customer_id) {
              let issueCreditsSuccess = false;

              // Set cooldown BEFORE attempting payment
              await setValue(cooldownKey, "true", AUTO_RECHARGE_COOLDOWN);

              // Attempt to create a payment intent
              const paymentStatus = await createPaymentIntent(
                chunk.team_id,
                customer.stripe_customer_id,
              );

              // If payment is successful or requires further action, issue credits
              if (
                paymentStatus.return_status === "succeeded" ||
                paymentStatus.return_status === "requires_action"
              ) {
                issueCreditsSuccess = await issueCredits(
                  chunk.team_id,
                  AUTO_RECHARGE_CREDITS,
                );
              }

              // Record the auto-recharge transaction
              await supabase_service.from("auto_recharge_transactions").insert({
                team_id: chunk.team_id,
                initial_payment_status: paymentStatus.return_status,
                credits_issued: issueCreditsSuccess ? AUTO_RECHARGE_CREDITS : 0,
                stripe_charge_id: paymentStatus.charge_id,
              });

              // Send a notification if credits were successfully issued
              if (issueCreditsSuccess) {
                // Increment hourly counter and set expiry if it doesn't exist
                await redisRateLimitClient.incr(hourlyCounterKey);
                await redisRateLimitClient.expire(
                  hourlyCounterKey,
                  HOURLY_COUNTER_EXPIRY,
                  "NX",
                );

                try {
                  // Check for frequent auto-recharges in the past week
                  const weeklyAutoRechargeKey = `auto-recharge-weekly:${chunk.team_id}`;
                  const weeklyRecharges = await redisRateLimitClient.incr(
                    weeklyAutoRechargeKey,
                  );
                  // Set expiry for 7 days if not already set
                  await redisRateLimitClient.expire(
                    weeklyAutoRechargeKey,
                    7 * 24 * 60 * 60,
                  );

                  // If this is the second auto-recharge in a week, send notification
                  if (weeklyRecharges >= 2) {
                    await sendNotificationWithCustomDays(
                      chunk.team_id,
                      NotificationType.AUTO_RECHARGE_FREQUENT,
                      7, // Send at most once per week
                      false,
                    );
                  }
                } catch (error) {
                  logger.error(
                    `Error sending frequent auto-recharge notification`,
                    { error },
                  );
                }

                await sendNotification(
                  chunk.team_id,
                  NotificationType.AUTO_RECHARGE_SUCCESS,
                  chunk.sub_current_period_start,
                  chunk.sub_current_period_end,
                  chunk,
                  true,
                  false,
                  { autoRechargeCredits: AUTO_RECHARGE_CREDITS },
                );

                // Reset ACUC cache to reflect the new credit balance
                await clearACUC(chunk.api_key);
                await clearACUCTeam(chunk.team_id);

                logger.info(`Auto-recharge successful`, {
                  credits: AUTO_RECHARGE_CREDITS,
                  paymentStatus: paymentStatus.return_status,
                });

                if (config.SLACK_ADMIN_WEBHOOK_URL) {
                  const webhookCooldownKey = `webhook_cooldown_${chunk.team_id}`;
                  const isInCooldown = await getValue(webhookCooldownKey);

                  if (!isInCooldown) {
                    sendSlackWebhook(
                      `Auto-recharge: Team ${chunk.team_id}. ${AUTO_RECHARGE_CREDITS} credits added. Payment status: ${paymentStatus.return_status}.`,
                      false,
                      config.SLACK_ADMIN_WEBHOOK_URL,
                    ).catch(error => {
                      logger.debug(
                        `Error sending slack notification: ${error}`,
                      );
                    });

                    // Set cooldown for 1 hour
                    await setValue(webhookCooldownKey, "true", 60 * 60);
                  }
                }
                return {
                  success: true,
                  message: "Auto-recharge successful",
                  remainingCredits:
                    chunk.remaining_credits + AUTO_RECHARGE_CREDITS,
                  chunk: {
                    ...chunk,
                    remaining_credits:
                      chunk.remaining_credits + AUTO_RECHARGE_CREDITS,
                  },
                };
              } else {
                logger.error("No Stripe customer ID found for user");
                return {
                  success: false,
                  message: "No Stripe customer ID found for user",
                  remainingCredits: chunk.remaining_credits,
                  chunk,
                };
              }
            } else {
              logger.error("No Stripe customer ID found for user");
              return {
                success: false,
                message: "No Stripe customer ID found for user",
                remainingCredits: chunk.remaining_credits,
                chunk,
              };
            }
          } else {
            logger.error("No sub_user_id found in chunk");
            return {
              success: false,
              message: "No sub_user_id found in chunk",
              remainingCredits: chunk.remaining_credits,
              chunk,
            };
          }
        }
        return {
          success: false,
          message: "No need to auto-recharge",
          remainingCredits: chunk.remaining_credits,
          chunk,
        };
      },
    );
  } catch (error) {
    logger.error(`Failed to acquire lock for auto-recharge`, { error });
    return {
      success: false,
      message: "Failed to acquire lock for auto-recharge",
      remainingCredits: chunk.remaining_credits,
      chunk,
    };
  }
}
