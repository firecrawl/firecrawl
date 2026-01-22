
import { checkForMetaBlocking } from "./meta-utils";

describe("checkForMetaBlocking", () => {
    it("should return true when meta noindex is present", () => {
        const html = '<html><head><meta name="FirecrawlAgent" content="noindex"></head><body>Blocked</body></html>';
        expect(checkForMetaBlocking(html)).toBe(true);
    });

    it("should return false when meta noindex is NOT present", () => {
        const html = '<html><head></head><body>Allowed</body></html>';
        expect(checkForMetaBlocking(html)).toBe(false);
    });

    it("should return true for case insensitive meta noindex", () => {
        const html = '<html><head><Meta Name="FirecrawlAgent" Content="NoIndex"></head><body>Blocked</body></html>';
        expect(checkForMetaBlocking(html)).toBe(true);
    });

    it("should return true for case insensitive tag name", () => {
        const html = '<html><head><meta name="firecrawlagent" content="noindex"></head><body>Blocked</body></html>';
        expect(checkForMetaBlocking(html)).toBe(true);
    });

    it("should return true for custom agent name", () => {
        const html = '<html><head><meta name="MyCustomAgent" content="noindex"></head><body>Blocked</body></html>';
        expect(checkForMetaBlocking(html, "MyCustomAgent")).toBe(true);
    });

    it("should return true for case insensitive custom agent name", () => {
        const html = '<html><head><meta name="mycustomagent" content="noindex"></head><body>Blocked</body></html>';
        expect(checkForMetaBlocking(html, "MyCustomAgent")).toBe(true);
    });

    it("should still block FirecrawlAgent when custom agent is provided", () => {
        const html = '<html><head><meta name="FirecrawlAgent" content="noindex"></head><body>Blocked</body></html>';
        expect(checkForMetaBlocking(html, "MyCustomAgent")).toBe(true);
    });

    it("should return true for mixed case tag name", () => {
        const html = '<html><head><meta name="FiReCrAwLaGeNt" content="noindex"></head><body>Blocked</body></html>';
        expect(checkForMetaBlocking(html)).toBe(true);
    });
});
