import { fetchProduct } from "../product";
import { config } from "../../../../config";

describe("fetchProduct", () => {
  const originalFetch = global.fetch;
  const originalServiceUrl = config.PRODUCT_EXTRACTION_SERVICE_URL;

  afterEach(() => {
    global.fetch = originalFetch;
    config.PRODUCT_EXTRACTION_SERVICE_URL = originalServiceUrl;
    vi.clearAllMocks();
  });

  function baseMeta(
    formats: any[] = [{ type: "product" }],
    zeroDataRetention = false,
    origin?: string,
  ) {
    return {
      url: "https://shop.test/p",
      rewrittenUrl: "https://shop.test/p",
      options: { formats },
      internalOptions: { zeroDataRetention, origin },
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
    } as any;
  }

  it("warns and yields no product when the service is not configured", async () => {
    config.PRODUCT_EXTRACTION_SERVICE_URL = undefined;
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const document: any = {
      rawHtml: "<html></html>",
      metadata: { url: "https://shop.test/p" },
    };

    const out = await fetchProduct(baseMeta(), document);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.product).toBeUndefined();
    expect(out.warning).toMatch(/not available/i);
  });

  it("refuses the product format under zero data retention without calling the service", async () => {
    config.PRODUCT_EXTRACTION_SERVICE_URL = "https://product.internal";
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const document: any = {
      rawHtml: "<html>jsonld</html>",
      metadata: { url: "https://shop.test/p" },
    };

    const out = await fetchProduct(
      baseMeta([{ type: "product" }], true),
      document,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.product).toBeUndefined();
    expect(out.warning).toBe(
      "Product format is not supported with zero data retention.",
    );
  });

  it("posts rawHtml to the service and sets document.product", async () => {
    config.PRODUCT_EXTRACTION_SERVICE_URL = "https://product.internal";
    const product = { title: "X", url: "https://shop.test/p", variants: [] };
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ product }),
    }));
    global.fetch = fetchSpy as any;
    const document: any = {
      rawHtml: "<html>jsonld</html>",
      metadata: { url: "https://shop.test/p" },
    };

    const out = await fetchProduct(baseMeta(), document);

    expect(out.product).toEqual(product);
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://product.internal/v1/extract-product");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      html: "<html>jsonld</html>",
      url: "https://shop.test/p",
    });
  });

  describe("unknown stock", () => {
    const serviceProduct = () => ({
      title: "X",
      url: "https://shop.test/p",
      variants: [
        { id: "1", availability: { inStock: true } },
        { id: "2", availability: { inStock: false } },
        { id: "3", availability: { inStock: null, text: "See store" } },
      ],
    });

    async function stockFor(origin?: string) {
      config.PRODUCT_EXTRACTION_SERVICE_URL = "https://product.internal";
      global.fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({ product: serviceProduct() }),
      })) as any;
      const document: any = {
        rawHtml: "<html>jsonld</html>",
        metadata: { url: "https://shop.test/p" },
      };
      const out = await fetchProduct(
        baseMeta([{ type: "product" }], false, origin),
        document,
      );
      return out.product!.variants.map(v => v.availability.inStock);
    }

    it.each([
      "python-sdk@4.57.0",
      "python-sdk.some-agent@4.30.3",
      "js-sdk@4.54.0",
      "java-sdk@1.18.0",
      "go-sdk@1.16.11",
      "rust-sdk@2.21.10",
      "ruby-sdk@1.17.8",
      "php-sdk@1.16.7",
      "dotnet-sdk@1.15.3",
      "python-sdk@not-a-version",
    ])("sends true for unknown stock to %s", async origin => {
      expect(await stockFor(origin)).toEqual([true, false, true]);
    });

    it.each([
      undefined,
      "api",
      "python-sdk@4.58.0",
      "js-sdk@4.55.0",
      "java-sdk@1.19.0",
      "go-sdk@1.17.0",
      "rust-sdk@2.22.0",
      "ruby-sdk@1.18.0",
      "php-sdk@1.17.0",
      "dotnet-sdk@1.16.0",
      "mcp-server",
      "cli.claude-code@1.29.0",
    ])("passes null through to %s", async origin => {
      expect(await stockFor(origin)).toEqual([true, false, null]);
    });
  });

  it("warns (no product) when the service reports no product", async () => {
    config.PRODUCT_EXTRACTION_SERVICE_URL = "https://product.internal";
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ product: null }),
    })) as any;
    const document: any = {
      rawHtml: "<p>about</p>",
      metadata: { url: "https://shop.test/a" },
    };

    const out = await fetchProduct(baseMeta(), document);

    expect(out.product).toBeUndefined();
    expect(out.warning).toMatch(/no product found/i);
  });

  it("throws when the service returns a non-JSON 200 response", async () => {
    config.PRODUCT_EXTRACTION_SERVICE_URL = "https://product.internal";
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    })) as any;
    const document: any = {
      rawHtml: "<html></html>",
      metadata: { url: "https://shop.test/p" },
    };

    await expect(fetchProduct(baseMeta(), document)).rejects.toThrow(
      /Product extraction failed/i,
    );
    expect(document.product).toBeUndefined();
    expect(document.warning).toBeUndefined();
  });

  it("throws when the service 200 response omits the product key", async () => {
    config.PRODUCT_EXTRACTION_SERVICE_URL = "https://product.internal";
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ unexpected: "shape" }),
    })) as any;
    const document: any = {
      rawHtml: "<html></html>",
      metadata: { url: "https://shop.test/p" },
    };

    await expect(fetchProduct(baseMeta(), document)).rejects.toThrow(
      /unexpected response/i,
    );
    expect(document.product).toBeUndefined();
    expect(document.warning).toBeUndefined();
  });

  it("early-returns when the product format isn't requested", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;
    const document: any = { rawHtml: "<html></html>", metadata: {} };

    const out = await fetchProduct(baseMeta([{ type: "markdown" }]), document);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out.product).toBeUndefined();
    expect(out.warning).toBeUndefined();
  });
});
