import { extractImages } from "../extractImages";

describe("extractImages", () => {
  const baseUrl = "https://example.com/page.html";

  it("should extract images from img tags", async () => {
    const html = `
      <html>
        <body>
          <img src="image1.jpg" alt="Test image 1">
          <img src="/images/image2.png" alt="Test image 2">
          <img src="https://external.com/image3.gif" alt="External image">
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/image1.jpg");
    expect(images).toContain("https://example.com/images/image2.png");
    expect(images).toContain("https://external.com/image3.gif");
    expect(images).toHaveLength(3);
  });

  it("should extract lazy-loaded images from data-src", async () => {
    const html = `
      <html>
        <body>
          <img data-src="lazy-image.webp" alt="Lazy loaded image">
          <img src="regular.jpg" data-src="ignored.jpg" alt="Both src and data-src">
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/lazy-image.webp");
    expect(images).toContain("https://example.com/regular.jpg");
    expect(images).toContain("https://example.com/ignored.jpg");
  });

  it("should extract images from srcset", async () => {
    const html = `
      <html>
        <body>
          <img srcset="small.jpg 480w, medium.jpg 800w, large.jpg 1200w" alt="Responsive image">
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/small.jpg");
    expect(images).toContain("https://example.com/medium.jpg");
    expect(images).toContain("https://example.com/large.jpg");
    expect(images).toHaveLength(3);
  });

  it("should extract images from picture elements", async () => {
    const html = `
      <html>
        <body>
          <picture>
            <source srcset="image.avif" type="image/avif">
            <source srcset="image.webp" type="image/webp">
            <img src="image.jpg" alt="Picture element">
          </picture>
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/image.avif");
    expect(images).toContain("https://example.com/image.webp");
    expect(images).toContain("https://example.com/image.jpg");
  });

  it("should extract images from meta tags", async () => {
    const html = `
      <html>
        <head>
          <meta property="og:image" content="https://example.com/og-image.jpg">
          <meta property="og:image:secure_url" content="https://example.com/og-image-secure.jpg">
          <meta name="twitter:image" content="https://example.com/twitter-image.png">
          <meta itemprop="image" content="/schema-image.jpg">
        </head>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/og-image.jpg");
    expect(images).toContain("https://example.com/og-image-secure.jpg");
    expect(images).toContain("https://example.com/twitter-image.png");
    expect(images).toContain("https://example.com/schema-image.jpg");
  });

  it("should extract images from link tags", async () => {
    const html = `
      <html>
        <head>
          <link rel="icon" href="/favicon.ico">
          <link rel="apple-touch-icon" href="/apple-touch-icon.png">
          <link rel="image_src" href="https://example.com/link-image.jpg">
        </head>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/favicon.ico");
    expect(images).toContain("https://example.com/apple-touch-icon.png");
    expect(images).toContain("https://example.com/link-image.jpg");
  });

  it("should extract background images from inline styles", async () => {
    const html = `
      <html>
        <body>
          <div style="background-image: url('background1.jpg');">Content</div>
          <div style="background-image: url(&quot;/images/background2.png&quot;);">Content</div>
          <div style="background-image: url(background3.gif);">Content</div>
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/background1.jpg");
    expect(images).toContain("https://example.com/images/background2.png");
    expect(images).toContain("https://example.com/background3.gif");
  });

  it("should extract video poster images", async () => {
    const html = `
      <html>
        <body>
          <video poster="video-poster.jpg"></video>
          <video poster="/videos/poster.png"></video>
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/video-poster.jpg");
    expect(images).toContain("https://example.com/videos/poster.png");
  });

  it("should handle protocol-relative URLs", async () => {
    const html = `
      <html>
        <body>
          <img src="//cdn.example.com/image.jpg" alt="Protocol relative">
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://cdn.example.com/image.jpg");
  });

  it("should handle data URIs", async () => {
    const html = `
      <html>
        <body>
          <img src="data:image/png;base64,iVBORw0KGgoAAAANS..." alt="Data URI">
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("data:image/png;base64,iVBORw0KGgoAAAANS...");
  });

  it("should respect base tag", async () => {
    const html = `
      <html>
        <head>
          <base href="https://different.com/base/">
        </head>
        <body>
          <img src="image.jpg" alt="Image with base">
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://different.com/base/image.jpg");
  });

  it("should remove duplicates", async () => {
    const html = `
      <html>
        <body>
          <img src="duplicate.jpg" alt="First">
          <img src="duplicate.jpg" alt="Second">
          <img src="/duplicate.jpg" alt="Third">
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    const duplicateCount = images.filter(img =>
      img.includes("duplicate.jpg"),
    ).length;
    expect(duplicateCount).toBe(1);
  });

  it("should handle invalid URLs gracefully", async () => {
    const html = `
      <html>
        <body>
          <img src="valid.jpg" alt="Valid">
          <img src="javascript:alert('xss')" alt="Invalid">
          <img src="" alt="Empty">
          <img alt="No src">
        </body>
      </html>
    `;

    const images = await extractImages(html, baseUrl);

    expect(images).toContain("https://example.com/valid.jpg");
    expect(images).not.toContain("javascript:alert('xss')");
    expect(images).toHaveLength(1);
  });
});
