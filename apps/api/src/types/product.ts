import { z } from "zod";

const productPriceSchema = z.object({
  amount: z.number(),
  currency: z.string().optional(),
  formatted: z.string().optional(),
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
  values: z.record(z.string(), z.string()).optional(),
  price: productPriceSchema.optional(),
  originalPrice: productPriceSchema.optional(),
  availability: productAvailabilitySchema.optional(),
  images: z.array(productImageSchema).optional(),
});
const productProfileSchema = z.object({
  title: z.string(),
  brand: z.string().optional(),
  category: z.string().optional(),
  url: z.string(),
  description: z.string().optional(),
  images: z.array(productImageSchema).optional(),
  price: productPriceSchema.optional(),
  originalPrice: productPriceSchema.optional(),
  availability: productAvailabilitySchema.optional(),
  variants: z.array(productVariantSchema),
});

export type ProductProfile = z.infer<typeof productProfileSchema>;
