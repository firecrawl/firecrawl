import { z } from "zod";

// Base schema without logoSelection
const baseBrandingEnhancementSchema = z.object({
  // Button classification - LLM picks which buttons are primary/secondary
  buttonClassification: z
    .object({
      primaryButtonIndex: z
        .number()
        .describe(
          "REQUIRED: Index of the primary CTA button in the provided list (0-based), or -1 if none found. YOU MUST RETURN THIS FIELD.",
        ),
      primaryButtonReasoning: z
        .string()
        .describe(
          "REQUIRED: Why this button was selected as primary. YOU MUST RETURN THIS FIELD.",
        ),
      secondaryButtonIndex: z
        .number()
        .describe(
          "REQUIRED: Index of the secondary button in the provided list (0-based), or -1 if none found. YOU MUST RETURN THIS FIELD.",
        ),
      secondaryButtonReasoning: z
        .string()
        .describe(
          "REQUIRED: Why this button was selected as secondary. YOU MUST RETURN THIS FIELD.",
        ),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe(
          "REQUIRED: Confidence in button classification (0-1). YOU MUST RETURN THIS FIELD.",
        ),
    })
    .default({
      primaryButtonIndex: -1,
      primaryButtonReasoning: "LLM did not return button classification",
      secondaryButtonIndex: -1,
      secondaryButtonReasoning: "LLM did not return button classification",
      confidence: 0,
    }),

  // Color role clarification
  colorRoles: z.object({
    primaryColor: z.string().describe("Main brand color (hex)"),
    accentColor: z.string().describe("Accent/CTA color (hex)"),
    backgroundColor: z.string().describe("Main background color (hex)"),
    textPrimary: z.string().describe("Primary text color (hex)"),
    confidence: z.number().min(0).max(1),
  }),

  // Brand personality
  personality: z.object({
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
  }),

  // Design system insights
  designSystem: z.object({
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
      .describe("Detected component library (e.g., radix-ui, shadcn)"),
  }),

  // Font cleaning - LLM cleans and filters font names
  cleanedFonts: z
    .array(
      z.object({
        family: z.string().describe("Cleaned, human-readable font name"),
        role: z
          .enum(["heading", "body", "monospace", "display", "unknown"])
          .describe("Font role/usage"),
      }),
    )
    .max(5)
    .describe(
      "Top 5 cleaned fonts (remove obfuscation, fallbacks, generics, CSS vars)",
    )
    .default([]),
});

// Schema with logoSelection (when logo candidates are provided)
const brandingEnhancementSchemaWithLogo = baseBrandingEnhancementSchema.extend({
  // Logo selection - LLM picks the best logo from candidates
  logoSelection: z.object({
    selectedLogoIndex: z
      .number()
      .describe(
        "REQUIRED: Index of the selected logo in the provided candidates list (0-based), or -1 if NONE of the candidates match the site's brand. Infer the brand from page title/URL when provided (e.g. 'X | Miro' → brand Miro). YOU MUST RETURN A NUMBER.",
      ),
    selectedLogoReasoning: z
      .string()
      .describe(
        "REQUIRED: Detailed explanation of why this logo was selected, or why none were suitable if returning -1. YOU MUST PROVIDE REASONING.",
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "REQUIRED: Confidence in logo selection (0-1). Return 0 if no suitable logo found.",
      ),
  }),
});

// Export function to get the appropriate schema based on whether logo candidates exist
export function getBrandingEnhancementSchema(hasLogoCandidates: boolean) {
  return hasLogoCandidates
    ? brandingEnhancementSchemaWithLogo
    : baseBrandingEnhancementSchema;
}

// Type - logoSelection is optional in the type even though it's required in schema when candidates exist
export type BrandingEnhancement = Omit<
  z.infer<typeof brandingEnhancementSchemaWithLogo>,
  "logoSelection"
> & {
  logoSelection?: z.infer<
    typeof brandingEnhancementSchemaWithLogo
  >["logoSelection"];
};
