import { rewriteUrl } from "../rewriteUrl";

describe("rewriteUrl", () => {
  describe("Google Docs", () => {
    it("should rewrite regular Google Docs URLs to PDF export", () => {
      const url =
        "https://docs.google.com/document/d/1iqj3PY--4lSBpVkavEpjlayx0AHJDglOnJmHNOpFP1U/edit";
      expect(rewriteUrl(url)).toBe(
        "https://docs.google.com/document/d/1iqj3PY--4lSBpVkavEpjlayx0AHJDglOnJmHNOpFP1U/export?format=pdf",
      );
    });

    it("should rewrite Google Docs URLs with query params", () => {
      const url =
        "https://docs.google.com/document/d/1iqj3PY--4lSBpVkavEpjlayx0AHJDglOnJmHNOpFP1U/edit?usp=sharing";
      expect(rewriteUrl(url)).toBe(
        "https://docs.google.com/document/d/1iqj3PY--4lSBpVkavEpjlayx0AHJDglOnJmHNOpFP1U/export?format=pdf",
      );
    });

    it("should NOT rewrite published Google Docs URLs (/d/e/)", () => {
      const url =
        "https://docs.google.com/document/d/e/2PACX-1vTZQI1NBJsuR-LUPEcN5NyUpdfXeS9ECHx5SrtJwpBa1J0nbYkoFqP1mE-1m43ixRaGuaxnT6fnHG1h/pub";
      expect(rewriteUrl(url)).toBeUndefined();
    });

    it("should NOT rewrite published Google Docs URLs with query params", () => {
      const url =
        "https://docs.google.com/document/d/e/2PACX-1vTZQI1NBJsuR-LUPEcN5NyUpdfXeS9ECHx5SrtJwpBa1J0nbYkoFqP1mE-1m43ixRaGuaxnT6fnHG1h/pub?embedded=true";
      expect(rewriteUrl(url)).toBeUndefined();
    });

    it("should handle http:// URLs", () => {
      const url =
        "http://docs.google.com/document/d/1iqj3PY--4lSBpVkavEpjlayx0AHJDglOnJmHNOpFP1U/edit";
      expect(rewriteUrl(url)).toBe(
        "https://docs.google.com/document/d/1iqj3PY--4lSBpVkavEpjlayx0AHJDglOnJmHNOpFP1U/export?format=pdf",
      );
    });
  });

  describe("Google Presentations", () => {
    it("should rewrite regular Google Slides URLs to PDF export", () => {
      const url =
        "https://docs.google.com/presentation/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit";
      expect(rewriteUrl(url)).toBe(
        "https://docs.google.com/presentation/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/export?format=pdf",
      );
    });

    it("should NOT rewrite published Google Slides URLs (/d/e/)", () => {
      const url =
        "https://docs.google.com/presentation/d/e/2PACX-1vSomePublishId/pub";
      expect(rewriteUrl(url)).toBeUndefined();
    });
  });

  describe("Google Sheets", () => {
    it("should rewrite Google Sheets URLs to HTML export", () => {
      const url =
        "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit";
      expect(rewriteUrl(url)).toBe(
        "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/gviz/tq?tqx=out:html",
      );
    });

    it("should preserve gid parameter from query string for specific sheet tab", () => {
      const url =
        "https://docs.google.com/spreadsheets/d/1dhyxGttUbI2RlTxPXF4CQcY4TD2k6Jp7-hcqS9PP5uc/edit?gid=89683736";
      expect(rewriteUrl(url)).toBe(
        "https://docs.google.com/spreadsheets/d/1dhyxGttUbI2RlTxPXF4CQcY4TD2k6Jp7-hcqS9PP5uc/gviz/tq?tqx=out:html&gid=89683736",
      );
    });

    it("should preserve gid parameter from hash fragment for specific sheet tab", () => {
      const url =
        "https://docs.google.com/spreadsheets/d/1dhyxGttUbI2RlTxPXF4CQcY4TD2k6Jp7-hcqS9PP5uc/edit#gid=89683736";
      expect(rewriteUrl(url)).toBe(
        "https://docs.google.com/spreadsheets/d/1dhyxGttUbI2RlTxPXF4CQcY4TD2k6Jp7-hcqS9PP5uc/gviz/tq?tqx=out:html&gid=89683736",
      );
    });

    it("should preserve gid parameter when both query and hash have gid (uses first match)", () => {
      const url =
        "https://docs.google.com/spreadsheets/d/1dhyxGttUbI2RlTxPXF4CQcY4TD2k6Jp7-hcqS9PP5uc/edit?gid=89683736#gid=89683736";
      expect(rewriteUrl(url)).toBe(
        "https://docs.google.com/spreadsheets/d/1dhyxGttUbI2RlTxPXF4CQcY4TD2k6Jp7-hcqS9PP5uc/gviz/tq?tqx=out:html&gid=89683736",
      );
    });

    it("should NOT rewrite published Google Sheets URLs (/d/e/)", () => {
      const url =
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vSomePublishId/pubhtml";
      expect(rewriteUrl(url)).toBeUndefined();
    });
  });

  describe("Google Drive", () => {
    it("should rewrite Google Drive file URLs to download", () => {
      const url =
        "https://drive.google.com/file/d/1a2b3c4d5e6f7g8h9i0j/view?usp=sharing";
      expect(rewriteUrl(url)).toBe(
        "https://drive.google.com/uc?export=download&id=1a2b3c4d5e6f7g8h9i0j",
      );
    });
  });

  describe("GitHub", () => {
    it("should rewrite blob (file) URLs to raw.githubusercontent.com", () => {
      const url =
        "https://github.com/vllm-project/semantic-router/blob/main/website/blog/2025-12-14-halugate.md";
      expect(rewriteUrl(url)).toBe(
        "https://raw.githubusercontent.com/vllm-project/semantic-router/main/website/blog/2025-12-14-halugate.md",
      );
    });

    it("should strip line-anchor fragments (#L42)", () => {
      const url =
        "https://github.com/user/repo/blob/main/src/components/Header.jsx#L42";
      expect(rewriteUrl(url)).toBe(
        "https://raw.githubusercontent.com/user/repo/main/src/components/Header.jsx",
      );
    });

    it("should strip UI query params (?plain=1)", () => {
      const url =
        "https://github.com/user/repo/blob/main/README.md?plain=1";
      expect(rewriteUrl(url)).toBe(
        "https://raw.githubusercontent.com/user/repo/main/README.md",
      );
    });

    it("should handle branch names with dots and slashes in path", () => {
      const url =
        "https://github.com/user/repo/blob/v1.2.3/pkg/dist/index.ts";
      expect(rewriteUrl(url)).toBe(
        "https://raw.githubusercontent.com/user/repo/v1.2.3/pkg/dist/index.ts",
      );
    });

    it("should handle http:// URLs", () => {
      const url = "http://github.com/user/repo/blob/main/file.md";
      expect(rewriteUrl(url)).toBe(
        "https://raw.githubusercontent.com/user/repo/main/file.md",
      );
    });

    it("should NOT rewrite /tree/ (directory) URLs", () => {
      const url = "https://github.com/user/repo/tree/main/src";
      expect(rewriteUrl(url)).toBeUndefined();
    });

    it("should NOT rewrite /commit/, /pull/, /issues/ URLs", () => {
      expect(
        rewriteUrl("https://github.com/user/repo/commit/abc123"),
      ).toBeUndefined();
      expect(
        rewriteUrl("https://github.com/user/repo/pull/42"),
      ).toBeUndefined();
      expect(
        rewriteUrl("https://github.com/user/repo/issues/42"),
      ).toBeUndefined();
    });
  });

  describe("Non-Google URLs", () => {
    it("should return undefined for non-Google URLs", () => {
      expect(rewriteUrl("https://example.com")).toBeUndefined();
      expect(rewriteUrl("https://firecrawl.dev")).toBeUndefined();
    });
  });
});
