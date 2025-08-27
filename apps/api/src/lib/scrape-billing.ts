import { InternalOptions } from "src/scraper/scrapeURL";
import { Document, ScrapeOptions, TeamFlags } from "../controllers/v2/types";
import { CostTracking } from "./extract/extraction-service";
import { hasFormatOfType } from "./format-utils";

const creditsPerPDFPage = 1;
const stealthProxyCostBonus = 4;

export async function calculateCreditsToBeBilled(options: ScrapeOptions, internalOptions: InternalOptions, document: Document | null, costTracking: CostTracking | ReturnType<typeof CostTracking.prototype.toJSON>, flags: TeamFlags) {
    const costTrackingJSON: ReturnType<typeof CostTracking.prototype.toJSON> = costTracking instanceof CostTracking ? costTracking.toJSON() : costTracking;

    if (document === null) {
        // Failure -- check cost tracking if FIRE-1
        let creditsToBeBilled = 0;

        if (internalOptions.v1Agent?.model?.toLowerCase() === "fire-1" || internalOptions.v1JSONAgent?.model?.toLowerCase() === "fire-1") {
            creditsToBeBilled = Math.ceil((costTrackingJSON.totalCost ?? 1) * 1800);
        } 
    
        return creditsToBeBilled;
    }

    let creditsToBeBilled = 1; // Assuming 1 credit per document
    const changeTrackingFormat = hasFormatOfType(options.formats, "changeTracking");
    if (hasFormatOfType(options.formats, "json") || changeTrackingFormat?.modes?.includes("json")) {
        creditsToBeBilled = 5;
    }

    if (internalOptions.v1Agent?.model === "fire-1" || internalOptions.v1JSONAgent?.model?.toLowerCase() === "fire-1") {
        creditsToBeBilled = Math.ceil((costTrackingJSON.totalCost ?? 1) * 1800);
    } 

    if (internalOptions.zeroDataRetention) {
        creditsToBeBilled += (flags?.zdrCost ?? 1);
    }
    
    const shouldParsePDF = options.parsers?.includes("pdf") ?? true;
    if (shouldParsePDF && document.metadata?.numPages !== undefined && document.metadata.numPages > 1) {
        creditsToBeBilled += creditsPerPDFPage * (document.metadata.numPages - 1);
    }

    if (document?.metadata?.proxyUsed === "stealth") {
        creditsToBeBilled += stealthProxyCostBonus;
    }

    return creditsToBeBilled;
}
