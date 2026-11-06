import { stripWwwFromUrl } from "./url-utils";

describe("stripWwwFromUrl", () => {
  it("removes a leading www. label from the hostname", () => {
    expect(stripWwwFromUrl("https://www.example.com/path")).toBe(
      "https://example.com/path",
    );
    expect(stripWwwFromUrl("http://www.example.com")).toBe(
      "http://example.com",
    );
  });

  it("handles uppercase scheme and host labels", () => {
    expect(stripWwwFromUrl("HTTPS://WWW.EXAMPLE.COM/Path")).toBe(
      "HTTPS://EXAMPLE.COM/Path",
    );
  });

  it("removes www. from a bare host without a scheme", () => {
    expect(stripWwwFromUrl("www.example.com/docs")).toBe("example.com/docs");
  });

  it("leaves www. inside a path untouched", () => {
    expect(stripWwwFromUrl("https://example.com/www.tutorials/page")).toBe(
      "https://example.com/www.tutorials/page",
    );
    expect(stripWwwFromUrl("https://example.com/docs/www.spec/page")).toBe(
      "https://example.com/docs/www.spec/page",
    );
  });

  it("leaves www. inside a query untouched", () => {
    expect(
      stripWwwFromUrl("https://example.com/redirect?url=www.partner.com"),
    ).toBe("https://example.com/redirect?url=www.partner.com");
  });

  it("leaves hosts where www. is part of a longer label untouched", () => {
    expect(stripWwwFromUrl("https://mywww.example.com")).toBe(
      "https://mywww.example.com",
    );
    expect(stripWwwFromUrl("https://www2.example.com")).toBe(
      "https://www2.example.com",
    );
  });

  it("leaves URLs without a www. label untouched", () => {
    expect(stripWwwFromUrl("https://example.com/path?x=1")).toBe(
      "https://example.com/path?x=1",
    );
    expect(stripWwwFromUrl("https://blog.example.com")).toBe(
      "https://blog.example.com",
    );
  });

  it("removes only one leading www. label", () => {
    expect(stripWwwFromUrl("https://www.www.example.com")).toBe(
      "https://www.example.com",
    );
  });

  it("strips www. from the hostname when userinfo is present", () => {
    expect(stripWwwFromUrl("https://user:pass@www.example.com/path")).toBe(
      "https://user:pass@example.com/path",
    );
  });

  it("never rewrites www. inside userinfo", () => {
    expect(stripWwwFromUrl("https://www.user:pass@example.com")).toBe(
      "https://www.user:pass@example.com",
    );
    expect(stripWwwFromUrl("https://user:www.@example.com")).toBe(
      "https://user:www.@example.com",
    );
  });

  it("preserves a port after the hostname", () => {
    expect(stripWwwFromUrl("https://www.example.com:8080/x")).toBe(
      "https://example.com:8080/x",
    );
  });
});
