const addon = require('../build/Release/html_to_markdown');

export interface HtmlConverter {
    convert(html: string, callback: (error: Error | null, result?: string) => void): void;
    convertSync(html: string): string;
}

export class HtmlToMarkdownConverter {
    private converter: HtmlConverter;

    constructor() {
        this.converter = new addon.HtmlConverter();
    }

    /**
     * Convert HTML to Markdown asynchronously
     */
    async convertAsync(html: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.converter.convert(html, (error, result) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result || '');
                }
            });
        });
    }

    /**
     * Convert HTML to Markdown synchronously
     */
    convertSync(html: string): string {
        return this.converter.convertSync(html);
    }
}

/**
 * Simple function interface - converts HTML to Markdown synchronously
 */
export function convertHtmlToMarkdown(html: string): string {
    return addon.convertSync(html);
}

/**
 * Simple function interface - converts HTML to Markdown asynchronously
 */
export async function convertHtmlToMarkdownAsync(html: string): Promise<string> {
    const converter = new HtmlToMarkdownConverter();
    return converter.convertAsync(html);
}

export default {
    HtmlToMarkdownConverter,
    convertHtmlToMarkdown,
    convertHtmlToMarkdownAsync
};