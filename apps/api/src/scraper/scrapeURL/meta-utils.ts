
import { load } from "cheerio";

export function checkForMetaBlocking(html: string, agentName?: string): boolean {
    const $ = load(html);
    let selector = 'meta[name="FirecrawlAgent"], meta[name="firecrawlagent"]';

    if (agentName && agentName.toLowerCase() !== 'firecrawlagent') {
        selector += `, meta[name="${agentName}"], meta[name="${agentName.toLowerCase()}"]`;
    }

    const metaTags = $(selector);
    let isBlocked = false;
    metaTags.each((_, element) => {
        const content = $(element).attr("content");
        if (content && content.toLowerCase().includes("noindex")) {
            isBlocked = true;
            return false; // break loop
        }
    });
    return isBlocked;
}
