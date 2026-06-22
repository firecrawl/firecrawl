import { z } from "zod";

// Canonical product shape, mirroring the product-extraction service's output
// (product-search `Product`). Everything that can differ by size, color, store
// selection, or stock state lives on a variant — there is no top-level price,
// availability, or images. A single-SKU product still has exactly one variant.
const productPriceSchema = z.object({
  amount: z.number(),
  currency: z.string().optional(),
  formatted: z.string().optional(),
});
const productSaleSchema = z.object({
  originalPrice: productPriceSchema,
});
const productAvailabilitySchema = z.object({
  inStock: z.boolean(),
  text: z.string().optional(),
});
const productImageSchema = z.object({
  url: z.string(),
  alt: z.string().optional(),
});
const productVariantSchema = z.object({
  id: z.string().optional(),
  sku: z.string().optional(),
  title: z.string().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
  price: productPriceSchema.optional(),
  sale: productSaleSchema.optional(),
  availability: productAvailabilitySchema,
  images: z.array(productImageSchema).optional(),
});
const productProfileSchema = z.object({
  title: z.string(),
  brand: z.string().optional(),
  category: z.string().optional(),
  url: z.string(),
  description: z.string().optional(),
  variants: z.array(productVariantSchema),
});

export type ProductProfile = z.infer<typeof productProfileSchema>;
