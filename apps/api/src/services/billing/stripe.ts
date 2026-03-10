import { logger } from "../../lib/logger";
import { config } from "../../config";
import Stripe from "stripe";

const stripe = new Stripe(config.STRIPE_SECRET_KEY ?? "");

async function getCustomerDefaultPaymentMethod(customerId: string) {
  const paymentMethods = await stripe.customers.listPaymentMethods(customerId, {
    limit: 3,
  });
  return paymentMethods.data[0] ?? null;
}

type ReturnStatus = "succeeded" | "requires_action" | "failed";
export async function createPaymentIntent(
  team_id: string,
  customer_id: string,
): Promise<{ return_status: ReturnStatus; charge_id: string }> {
  try {
    const defaultPaymentMethod =
      await getCustomerDefaultPaymentMethod(customer_id);
    if (!defaultPaymentMethod) {
      logger.error(
        `No default payment method found for customer: ${customer_id}`,
        { team_id },
      );
      return { return_status: "failed", charge_id: "" };
    }
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 1100,
      currency: "usd",
      customer: customer_id,
      description: "Firecrawl: Auto re-charge of 1000 credits",
      payment_method_types: [defaultPaymentMethod?.type ?? "card"],
      payment_method: defaultPaymentMethod?.id,
      off_session: true,
      confirm: true,
      metadata: {
        team_id,
        auto_recharge: "true",
      },
    });

    if (paymentIntent.status === "succeeded") {
      logger.info(`Payment succeeded for team: ${team_id}`);
      return { return_status: "succeeded", charge_id: paymentIntent.id };
    } else if (
      paymentIntent.status === "requires_action" ||
      paymentIntent.status === "processing" ||
      paymentIntent.status === "requires_capture"
    ) {
      logger.warn(`Payment requires further action for team: ${team_id}`);
      return { return_status: "requires_action", charge_id: paymentIntent.id };
    } else {
      logger.error(`Payment failed for team: ${team_id}`);
      return { return_status: "failed", charge_id: paymentIntent.id };
    }
  } catch (error) {
    logger.error(
      `Failed to create or confirm PaymentIntent for team: ${team_id}`,
    );
    console.error(error);
    return { return_status: "failed", charge_id: "" };
  }
}

export async function createSubscription(
  team_id: string,
  customer_id: string,
  price_id: string,
  main_subscription_id: string,
  invoiceOnly = false,
) {
  const defaultPaymentMethod = invoiceOnly
    ? null
    : await getCustomerDefaultPaymentMethod(customer_id);
  if (!invoiceOnly && !defaultPaymentMethod) {
    logger.error("No default payment method found for customer", {
      team_id,
      customer_id,
    });
    return null;
  }

  let useCoupons: string[] = [];

  const mainSub = await stripe.subscriptions.retrieve(main_subscription_id, {
    expand: ["discounts"],
  });
  if (mainSub) {
    // Clone coupons from main subscription to auto recharge expansion
    useCoupons = (
      await Promise.all(
        ((mainSub.discounts ?? []) as Stripe.Discount[]).map(async discount => {
          if (discount.coupon.duration === "once") {
            return null;
          }

          if (
            discount.coupon.duration === "repeating" &&
            new Date(discount.end! * 1000) < new Date()
          ) {
            return null;
          }

          if (!discount.coupon.valid) {
            const duration_in_months =
              discount.coupon.duration === "repeating"
                ? Math.round(
                    (new Date(discount.end! * 1000).valueOf() -
                      new Date(discount.start! * 1000).valueOf()) /
                      (1000 * 60 * 60 * 24 * 30),
                  )
                : 0;
            const coupon = await stripe.coupons.create({
              name: discount.coupon.name ?? undefined,
              duration: duration_in_months > 0 ? "repeating" : "once",
              ...(duration_in_months > 0 ? { duration_in_months } : {}),
              max_redemptions: 1,
              ...(discount.coupon.amount_off
                ? { amount_off: discount.coupon.amount_off }
                : {}),
              ...(discount.coupon.currency
                ? { currency: discount.coupon.currency }
                : {}),
              ...(discount.coupon.currency_options
                ? { currency_options: discount.coupon.currency_options }
                : {}),
              metadata: {
                ...(discount.coupon.metadata ?? {}),
                team_id,
                auto_recharge: "true",
              },
              ...(discount.coupon.percent_off
                ? { percent_off: discount.coupon.percent_off }
                : {}),
              ...(discount.coupon.applies_to
                ? { applies_to: discount.coupon.applies_to }
                : {}),
            });
            return coupon.id;
          } else {
            return discount.coupon.id;
          }
        }),
      )
    ).filter(x => x !== null);
  } else {
    logger.warn("No main subscription found for customer", {
      team_id,
      customer_id,
    });
  }

  const subscription = await stripe.subscriptions.create({
    customer: customer_id,
    items: [{ price: price_id }],
    ...(invoiceOnly
      ? {
          collection_method: "send_invoice",
          days_until_due: 30,
        }
      : {
          off_session: true,
          payment_settings: {
            payment_method_types: [
              (defaultPaymentMethod?.type as Stripe.SubscriptionCreateParams.PaymentSettings.PaymentMethodType) ??
                "card",
            ],
          },
          default_payment_method: defaultPaymentMethod?.id,
          collection_method: "charge_automatically",
        }),
    metadata: {
      team_id,
      auto_recharge: "true",
    },
    ...(useCoupons.length > 0
      ? { discounts: useCoupons.map(coupon => ({ coupon })) }
      : {}),
  });

  return subscription;
}

export async function customerToUserId(customerId: string) {
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer || customer.deleted) return null;
  return customer.metadata.supabaseUUID ?? null;
}
