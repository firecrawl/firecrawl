import {
  canonicalizeHost,
  canonicalizeUrl,
  generateUrlExpressions,
} from "./canonicalize";

// Google's published canonicalization test vectors, verbatim:
// https://cloud.google.com/web-risk/docs/urls-hashing#canonicalization
// (identical to the Safe Browsing v4 vectors).
const CANONICALIZATION_VECTORS: [string, string][] = [
  ["http://host/%25%32%35", "http://host/%25"],
  ["http://host/%25%32%35%25%32%35", "http://host/%25%25"],
  ["http://host/%2525252525252525", "http://host/%25"],
  ["http://host/asdf%25%32%35asd", "http://host/asdf%25asd"],
  ["http://host/%%%25%32%35asd%%", "http://host/%25%25%25asd%25%25"],
  ["http://www.google.com/", "http://www.google.com/"],
  [
    "http://%31%36%38%2e%31%38%38%2e%39%39%2e%32%36/%2E%73%65%63%75%72%65/%77%77%77%2E%65%62%61%79%2E%63%6F%6D/",
    "http://168.188.99.26/.secure/www.ebay.com/",
  ],
  [
    "http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/",
    "http://195.127.0.11/uploads/%20%20%20%20/.verify/.eBaysecure=updateuserdataxplimnbqmn-xplmvalidateinfoswqpcmlx=hgplmcx/",
  ],
  [
    "http://host%23.com/%257Ea%2521b%2540c%2523d%2524e%25f%255E00%252611%252A22%252833%252944_55%252B",
    "http://host%23.com/~a!b@c%23d$e%25f^00&11*22(33)44_55+",
  ],
  ["http://3279880203/blah", "http://195.127.0.11/blah"],
  ["http://www.google.com/blah/..", "http://www.google.com/"],
  ["www.google.com/", "http://www.google.com/"],
  ["www.google.com", "http://www.google.com/"],
  ["http://www.evil.com/blah#frag", "http://www.evil.com/blah"],
  ["http://www.GOOgle.com/", "http://www.google.com/"],
  ["http://www.google.com.../", "http://www.google.com/"],
  [
    "http://www.google.com/foo\tbar\rbaz\n2",
    "http://www.google.com/foobarbaz2",
  ],
  ["http://www.google.com/q?", "http://www.google.com/q?"],
  ["http://www.google.com/q?r?", "http://www.google.com/q?r?"],
  ["http://www.google.com/q?r?s", "http://www.google.com/q?r?s"],
  ["http://evil.com/foo#bar#baz", "http://evil.com/foo"],
  ["http://evil.com/foo;", "http://evil.com/foo;"],
  ["http://evil.com/foo?bar;", "http://evil.com/foo?bar;"],
  ["http://\x01\x80.com/", "http://%01%80.com/"],
  ["http://notrailingslash.com", "http://notrailingslash.com/"],
  ["http://www.gotaport.com:1234/", "http://www.gotaport.com/"],
  ["  http://www.google.com/  ", "http://www.google.com/"],
  ["http:// leadingspace.com/", "http://%20leadingspace.com/"],
  ["http://%20leadingspace.com/", "http://%20leadingspace.com/"],
  ["%20leadingspace.com/", "http://%20leadingspace.com/"],
  ["https://www.securesite.com/", "https://www.securesite.com/"],
  ["http://host.com/ab%23cd", "http://host.com/ab%23cd"],
  [
    "http://host.com//twoslashes?more//slashes",
    "http://host.com/twoslashes?more//slashes",
  ],
];

describe("canonicalizeUrl", () => {
  it.each(CANONICALIZATION_VECTORS)("canonicalizes %j", (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  // The published vectors never exercise %XX escapes inside the query, but
  // the spec's "repeatedly unescape, then escape once" step applies to the
  // whole URL — Google's reference implementations unescape the query too.
  // Without it, a valid escape like %20 double-escapes to %2520, hashes to a
  // different expression than the list entry, and silently never matches.
  it.each([
    // Already-canonical escape survives the unescape/escape round trip.
    ["http://host.com/p?q=%20x", "http://host.com/p?q=%20x"],
    // Double-escaped input converges instead of gaining another layer.
    ["http://host.com/p?q=%2520x", "http://host.com/p?q=%20x"],
    // Escapes of printable ASCII outside the escape class are dropped.
    ["http://host.com/p?q=%61", "http://host.com/p?q=a"],
  ] as [string, string][])(
    "percent-unescapes the query: %j",
    (input, expected) => {
      expect(canonicalizeUrl(input)).toBe(expected);
    },
  );
});

describe("canonicalizeHost", () => {
  it("normalizes dots and case", () => {
    expect(canonicalizeHost(".Example..COM.")).toBe("example.com");
  });

  it("normalizes integer, octal and hex IP forms", () => {
    expect(canonicalizeHost("3279880203")).toBe("195.127.0.11");
    expect(canonicalizeHost("0303.0177.0.013")).toBe("195.127.0.11");
    expect(canonicalizeHost("0xc3.0x7f.0x0.0xb")).toBe("195.127.0.11");
    expect(canonicalizeHost("195.127.11")).toBe("195.127.0.11");
  });

  it("leaves regular hostnames that merely look numeric-ish alone", () => {
    expect(canonicalizeHost("1234x.com")).toBe("1234x.com");
    expect(canonicalizeHost("256.256.256.256")).toBe("256.256.256.256");
  });
});

describe("generateUrlExpressions", () => {
  // Google's published suffix/prefix expression examples, verbatim:
  // https://cloud.google.com/web-risk/docs/urls-hashing#suffixprefix_expressions
  it("matches the spec example for a URL with path and query", () => {
    expect(generateUrlExpressions("http://a.b.com/1/2.html?param=1")).toEqual([
      "a.b.com/1/2.html?param=1",
      "a.b.com/1/2.html",
      "a.b.com/",
      "a.b.com/1/",
      "b.com/1/2.html?param=1",
      "b.com/1/2.html",
      "b.com/",
      "b.com/1/",
    ]);
  });

  it("matches the spec example for a long hostname (last five components)", () => {
    expect(generateUrlExpressions("http://a.b.c.d.e.f.g/1.html")).toEqual([
      "a.b.c.d.e.f.g/1.html",
      "a.b.c.d.e.f.g/",
      // (Note: skip "b.c.d.e.f.g", since we'll take only the last five
      // hostname components, and the full hostname.)
      "c.d.e.f.g/1.html",
      "c.d.e.f.g/",
      "d.e.f.g/1.html",
      "d.e.f.g/",
      "e.f.g/1.html",
      "e.f.g/",
      "f.g/1.html",
      "f.g/",
    ]);
  });

  it("matches the spec example for an IP host (no suffix walk)", () => {
    expect(generateUrlExpressions("http://1.2.3.4/1/")).toEqual([
      "1.2.3.4/1/",
      "1.2.3.4/",
    ]);
  });

  it("caps path prefixes at the root plus the first three components", () => {
    expect(generateUrlExpressions("http://example.com/a/b/c/d/e.html")).toEqual(
      [
        "example.com/a/b/c/d/e.html",
        "example.com/",
        "example.com/a/",
        "example.com/a/b/",
        "example.com/a/b/c/",
      ],
    );
  });

  it("expands a bare domain to its root expression (crawl seeds etc.)", () => {
    expect(generateUrlExpressions("example.com")).toEqual(["example.com/"]);
    expect(generateUrlExpressions("www.phishing.example.com")).toEqual([
      "www.phishing.example.com/",
      "phishing.example.com/",
      "example.com/",
    ]);
  });

  it("canonicalizes host and IP forms before expanding", () => {
    expect(generateUrlExpressions("WWW.Example.COM.")).toEqual([
      "www.example.com/",
      "example.com/",
    ]);
    expect(generateUrlExpressions("http://3279880203/blah")).toEqual([
      "195.127.0.11/blah",
      "195.127.0.11/",
    ]);
  });

  it("puts the exact host + path + query expression first", () => {
    const expressions = generateUrlExpressions(
      "https://sub.example.com/page?x=1",
    );
    expect(expressions[0]).toBe("sub.example.com/page?x=1");
  });
});
