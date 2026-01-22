
import { load } from "cheerio";

export function checkForMetaBlocking(html: string, agentName?: string): boolean {
    const $ = load(html);
    const metaTags = $('meta[name]');
    let isBlocked = false;

    metaTags.each((_, element) => {
        const name = $(element).attr("name");
        const content = $(element).attr("content");

        if (!name || !content) return;

        const lowerName = name.toLowerCase();
        const lowerContent = content.toLowerCase();

        if (lowerContent.includes("noindex")) {
            if (lowerName === "firecrawlagent" || (agentName && lowerName === agentName.toLowerCase())) {
                isBlocked = true;
                return false; // break loop
            }
        }
    });

    return isBlocked;
}
