// Prompt the codegen model for the extractor, then statically validate it with
// the TypeScript parser before we bother forking a sandbox: clean the source
// down to the extract function, check it parses and has the right shape, and
// reject references to globals the sandbox can't provide. Each rejection is fed
// back as feedback for one regeneration. Runtime problems (a selector that
// throws, a logic bug) still surface only on execution.
import { generateCode } from "../llm/client";
import { CostTracking } from "../../cost-tracking";
import { buildExtractorMessages } from "../llm/prompts";
import { errorMessage, log } from "../core/util";
import {
  cleanGeneratedCode,
  formatGeneratedCodeIssues,
  validateGeneratedExtractor,
  type GeneratedCodeIssue,
} from "./validate";

const MAX_ATTEMPTS = 2;

export async function generateExtractor(
  args: {
    anchorHtml: string;
    markdownPreview: string;
    schemaJson: string;
    prompt: string;
    rejectionFeedback?: string;
    previousCode?: string;
  },
  costTracking: CostTracking,
): Promise<string> {
  let feedback = args.rejectionFeedback;
  let previousCode = args.previousCode;
  let lastIssues: GeneratedCodeIssue[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { content, truncated } = await generateCode(
      buildExtractorMessages({
        userPrompt: args.prompt,
        schemaJson: args.schemaJson,
        markdownPreview: args.markdownPreview,
        anchorHtml: args.anchorHtml,
        rejectionFeedback: feedback,
        previousCode,
      }),
      costTracking,
    );

    if (truncated) {
      throw new Error("codegen output was truncated; raise CODEGEN_MAX_TOKENS");
    }

    let code = "";
    let issues: GeneratedCodeIssue[] = [];
    try {
      code = cleanGeneratedCode(content);
      issues = validateGeneratedExtractor(code);
    } catch (err) {
      issues = [
        {
          field: "source",
          reason: errorMessage(err),
          excerpt: content.replace(/\s+/g, " ").slice(0, 180),
        },
      ];
    }

    if (issues.length === 0) {
      log(`extractor generated (attempt ${attempt}, ${code.length} chars)`);
      return code;
    }

    lastIssues = issues;
    feedback = formatGeneratedCodeIssues(issues);
    // Repair our own latest attempt next round, not the stale code passed in.
    if (code) previousCode = code;
    log(
      `rejecting extractor attempt ${attempt}: ${issues.length} issue(s)\n${feedback}`,
    );
  }

  throw new Error(
    "extractor failed validation after retry:\n" +
      formatGeneratedCodeIssues(lastIssues),
  );
}
