import {
  getModelPrice as nativeGetModelPrice,
  getModelPriceKeys as nativeGetModelPriceKeys,
  hasModelPrice as nativeHasModelPrice,
} from "@mendable/firecrawl-rs";

export interface ModelPrice {
  litellm_provider: string;
  mode?: string;
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_token_batches?: number;
  output_cost_per_token_batches?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  [key: string]: unknown;
}

/** Look up pricing and capability metadata for a model by exact key. */
export function getModelPrice(model: string): ModelPrice | undefined {
  if (typeof model !== "string") {
    return undefined;
  }
  return (nativeGetModelPrice(model) as ModelPrice | null) ?? undefined;
}

/** Check whether a model key exists in the pricing table (exact, case-sensitive). */
export function hasModelPrice(model: string): boolean {
  if (typeof model !== "string") {
    return false;
  }
  return nativeHasModelPrice(model);
}

/**
 * Read-only lookup view backed by the native static table so the full
 * pricing catalog does not live on the V8 heap.
 */
export const modelPrices: Readonly<Record<string, any>> = new Proxy(
  {} as Record<string, any>,
  {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const entry = nativeGetModelPrice(prop);
        if (entry !== null) {
          return entry;
        }
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string" && nativeHasModelPrice(prop)) {
        return true;
      }
      return Reflect.has(target, prop);
    },
    ownKeys() {
      return nativeGetModelPriceKeys();
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === "string" && nativeHasModelPrice(prop)) {
        return {
          configurable: true,
          enumerable: true,
          get() {
            return nativeGetModelPrice(prop) ?? undefined;
          },
        };
      }
      return undefined;
    },
    set() {
      return false;
    },
    defineProperty() {
      return false;
    },
    deleteProperty() {
      return false;
    },
  },
);
