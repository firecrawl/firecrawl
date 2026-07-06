import {
  canonicalizeHost,
  canonicalizeUrl,
  generateHostExpressions,
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

describe("generateHostExpressions", () => {
  // Spec example (host component of "http://a.b.c.d.e.f.g/1.html"): the
  // exact host plus the four suffixes built from the last five components.
  it("walks at most the last five host components", () => {
    expect(generateHostExpressions("a.b.c.d.e.f.g")).toEqual([
      "a.b.c.d.e.f.g/",
      "c.d.e.f.g/",
      "d.e.f.g/",
      "e.f.g/",
      "f.g/",
    ]);
  });

  it("generates exact host + registrable suffixes for short hosts", () => {
    expect(generateHostExpressions("a.b.c")).toEqual(["a.b.c/", "b.c/"]);
    expect(generateHostExpressions("example.com")).toEqual(["example.com/"]);
    expect(generateHostExpressions("www.phishing.example.com")).toEqual([
      "www.phishing.example.com/",
      "phishing.example.com/",
      "example.com/",
    ]);
  });

  it("generates a single expression for IP hosts (no suffix walk)", () => {
    expect(generateHostExpressions("195.127.0.11")).toEqual(["195.127.0.11/"]);
    expect(generateHostExpressions("3279880203")).toEqual(["195.127.0.11/"]);
  });

  it("canonicalizes the host before expanding", () => {
    expect(generateHostExpressions("WWW.Example.COM.")).toEqual([
      "www.example.com/",
      "example.com/",
    ]);
  });
});
