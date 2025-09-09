import { isGoogleMissingDescription, sanitizeDescription, generateFallbackDescription } from '../../../search/v2/utils/description-sanitizer';

describe('Description Sanitizer', () => {
    describe('isGoogleMissingDescription', () => {
        it('should detect Missing: descriptions', () => {
            expect(isGoogleMissingDescription("Missing: me personal webpage optionally wikipedia, google Princeton Atelier")).toBe(true);
            expect(isGoogleMissingDescription("Missing: some terms")).toBe(true);
            expect(isGoogleMissingDescription("Normal description")).toBe(false);
            expect(isGoogleMissingDescription("")).toBe(false);
        });
    });

    describe('generateFallbackDescription', () => {
        it('should generate reasonable fallback descriptions', () => {
            const result = generateFallbackDescription(
                "https://www.principiacollege.edu/academics/faculty/profile/~board/college-staff/post/eckert-s",
                "Dr. Scott A. Eckert | Faculty Profile - Principia College"
            );
            expect(result).toBe("Dr. Scott A. Eckert | Faculty Profile - Principia College - Information from principiacollege.edu");
        });

        it('should handle cases with no title', () => {
            const result = generateFallbackDescription(
                "https://example.com/page",
                ""
            );
            expect(result).toBe("Content from example.com");
        });
    });

    describe('sanitizeDescription', () => {
        it('should replace Missing: descriptions with fallbacks', () => {
            const result = sanitizeDescription(
                "Missing: me personal webpage optionally wikipedia, google Princeton Atelier",
                "https://www.principiacollege.edu/academics/faculty/profile/~board/college-staff/post/eckert-s",
                "Dr. Scott A. Eckert | Faculty Profile - Principia College"
            );
            expect(result).toBe("Dr. Scott A. Eckert | Faculty Profile - Principia College - Information from principiacollege.edu");
        });

        it('should keep normal descriptions unchanged', () => {
            const normalDesc = "This is a normal description about the page content";
            const result = sanitizeDescription(
                normalDesc,
                "https://example.com",
                "Example Page"
            );
            expect(result).toBe(normalDesc);
        });
    });
});
