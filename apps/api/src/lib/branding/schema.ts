import { z } from "zod";

// Schema for LLM output
export const brandingEnhancementSchema = z.object({
  // Button classification - LLM picks which buttons are primary/secondary
  buttonClassification: z.object({
    primaryButtonIndex: z
      .number()
      .describe(
        "Index of the primary CTA button in the provided list (0-based), or -1 if none found",
      ),
    primaryButtonReasoning: z
      .string()
      .describe("Why this button was selected as primary"),
    secondaryButtonIndex: z
      .number()
      .describe(
        "Index of the secondary button in the provided list (0-based), or -1 if none found",
      ),
    secondaryButtonReasoning: z
      .string()
      .describe("Why this button was selected as secondary"),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Confidence in button classification (0-1)"),
  }),

  // Color role clarification
  colorRoles: z.object({
    primaryColor: z.string().nullish().describe("Main brand color (hex)"),
    accentColor: z.string().nullish().describe("Accent/CTA color (hex)"),
    backgroundColor: z
      .string()
      .nullish()
      .describe("Main background color (hex)"),
    textPrimary: z.string().nullish().describe("Primary text color (hex)"),
    confidence: z.number().min(0).max(1),
  }),

  // Brand personality
  personality: z
    .object({
      tone: z
        .enum([
          "professional",
          "playful",
          "modern",
          "traditional",
          "minimalist",
          "bold",
        ])
        .describe("Overall brand tone"),
      energy: z.enum(["low", "medium", "high"]).describe("Visual energy level"),
      targetAudience: z.string().describe("Perceived target audience"),
    })
    .optional(),

  // Design system insights
  designSystem: z
    .object({
      framework: z
        .enum([
          "tailwind",
          "bootstrap",
          "material",
          "chakra",
          "custom",
          "unknown",
        ])
        .describe("Detected CSS framework"),
      componentLibrary: z
        .string()
        .nullish()
        .describe("Detected component library (e.g., radix-ui, shadcn)"),
    })
    .optional(),

  // Font cleaning - LLM cleans and filters font names
  cleanedFonts: z
    .array(
      z.object({
        family: z.string().describe("Cleaned, human-readable font name"),
        role: z
          .enum(["heading", "body", "monospace", "display"])
          .nullish()
          .describe("Font role/usage"),
      }),
    )
    .max(5)
    .describe(
      "Top 5 cleaned fonts (remove obfuscation, fallbacks, generics, CSS vars)",
    ),

  // Logo selection - LLM picks the best logo from candidates
  logoSelection: z
    .object({
      selectedLogoIndex: z
        .number()
        .describe(
          "Index of the selected logo in the provided candidates list (0-based), or -1 if none found",
        )
        .optional(),
      selectedLogoReasoning: z
        .string()
        .describe("Why this logo was selected as the brand logo")
        .optional(),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe("Confidence in logo selection (0-1)")
        .optional(),
    })
    .optional(),
});

export type BrandingEnhancement = z.infer<typeof brandingEnhancementSchema>;
