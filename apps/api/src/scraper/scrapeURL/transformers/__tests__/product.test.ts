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

  function baseMeta(formats: any[] = [{ type: "product" }]) {
    return {
      url: "https://shop.test/p",
      rewrittenUrl: "https://shop.test/p",
      options: { formats },
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
