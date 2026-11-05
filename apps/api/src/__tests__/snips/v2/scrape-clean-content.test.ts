import { config } from "../../../config";
import {
  isProtectedBlock,
  splitMarkdownBlocks,
  stripHeadingAnchorLinks,
} from "../../../scraper/scrapeURL/transformers/cleanContent";
import {
  ALLOW_TEST_SUITE_WEBSITE,
  describeIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { Identity, idmux, scrape, scrapeRaw, scrapeTimeout } from "./lib";

const HAS_AI =
  !process.env.TEST_SUITE_SELF_HOSTED ||
  !!process.env.OPENAI_API_KEY ||
  !!process.env.OLLAMA_BASE_URL;

// The API server reads the same environment, so this tells whether it answers
// onlyCleanContent with the deletion-only cleaner.
const DELETION_CLEANER =
  config.ONLY_CLEAN_CONTENT_MODE === "on" &&
  config.ONLY_CLEAN_CONTENT_PERCENT >= 100;

const blocksOf = (markdown: string) =>
  splitMarkdownBlocks(markdown).map(stripHeadingAnchorLinks);

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "v2-scrape-clean-content",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000 + scrapeTimeout);

describeIf(ALLOW_TEST_SUITE_WEBSITE && HAS_AI && DELETION_CLEANER)(
  "V2 Scrape onlyCleanContent (deletion-only)",
  () => {
    const url = `${TEST_SUITE_WEBSITE}/blog/launch-week-iii-day-1-introducing-change-tracking`;

    it.concurrent(
      "only deletes whole blocks and keeps every heading, code block and table",
      async () => {
        const [plain, cleanRes] = await Promise.all([
          scrape({ url, formats: ["markdown"] }, identity),
          scrapeRaw(
            { url, formats: ["markdown"], onlyCleanContent: true },
            identity,
          ),
        ]);

        expect(cleanRes.statusCode).toBe(200);
        const clean = cleanRes.body.data;
        expect(clean.warning ?? "").not.toContain("Content cleaning failed");
        expect(clean.warning ?? "").not.toContain(
          "Content cleaning was skipped",
        );

        const plainBlocks = blocksOf(plain.markdown!);
        const cleanBlocks = blocksOf(clean.markdown!);
        expect(cleanBlocks.length).toBeGreaterThan(0);
        expect(cleanBlocks.length).toBeLessThan(plainBlocks.length);
        let plainIndex = 0;
        for (const block of cleanBlocks) {
          while (
            plainIndex < plainBlocks.length &&
            plainBlocks[plainIndex] !== block
          ) {
            plainIndex++;
          }
          expect(plainIndex).toBeLessThan(plainBlocks.length);
          plainIndex++;
        }

        const protectedBlocks = plainBlocks.filter(isProtectedBlock);
        expect(protectedBlocks.length).toBeGreaterThan(0);
        const remainingBlocks = [...cleanBlocks];
        for (const block of protectedBlocks) {
          const index = remainingBlocks.indexOf(block);
          expect(index).toBeGreaterThanOrEqual(0);
          remainingBlocks.splice(index, 1);
        }
      },
      scrapeTimeout * 2,
    );
  },
);
