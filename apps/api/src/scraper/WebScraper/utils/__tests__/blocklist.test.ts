import { decryptAES, isUrlBlocked } from "../blocklist";

const hashKey = Buffer.from(process.env.HASH_KEY || "", "utf-8");

describe("isUrlBlocked function", () => {
  beforeAll(() => {
    // Mock the decryptedBlocklist function to return known values
    jest
      .spyOn(require("../blocklist"), "decryptedBlocklist")
      .mockReturnValue([
        "h8ngAFXUNLO3ZqQufJjGVA==",
        "fEGiDm/TWDBkXUXejFVICg==",
        "l6Mei7IGbEmTTFoSudUnqQ==",
        "4OjallJzXRiZUAWDiC2Xww==",
        "ReSvkSfx34TNEdecmmSDdQ==",
        "X1E4WtdmXAv3SAX9xN925Q==",
        "VTzBQfMtXZzM05mnNkWkjA==",
        "m/q4Lb2Z8cxwU7/CoztOFg==",
        "UbVnmRaeG+gKcyVDLAm0vg==",
        "xNQhczYG22tTVc6lYE3qwg==",
        "CQfGDydbg4l1swRCru6O6Q==",
        "l86LQxm2NonTWMauXwEsPw==",
        "6v4QDUcwjnID80G+uU+tgw==",
        "pCF/6nrKZAxaYntzEGluZQ==",
        "r0CRhAmQqSe7V2s3073T00sAh4WcS5779jwuGJ26ows==",
        "aBOVqRFBM4UVg33usY10NdiF0HCnFH/ImtD0n+zIpc8==",
        "QV436UZuQ6D0Dqrx9MwaGw==",
        "OYVvrwILYbzA2mSSqOPPpw==",
        "xW2i4C0Dzcnp+qu12u0SAw==",
        "OLHba209l0dfl0MI4EnQonBITK9z8Qwgd/NsuaTkXmA=",
        "X0VynmNjpL3PrYxpUIG7sFMBt8OlrmQWtxj8oXVu2QM=",
        "ObdlM5NEkvBJ/sojRW5K/Q==",
        "C8Th38X0SjsE1vL/OsD8bA==",
        "PTbGg8PK/h0Seyw4HEpK4Q==",
        "lZdQMknjHb7+4+sjF3qNTw==",
        "LsgSq54q5oDysbva29JxnQ==",
        "KZfBtpwjOpdSoqacRbz7og==",
        "Indtl4yxJMHCKBGF4KABCQ==",
        "e3HFXLVgxhaVoadYpwb2BA==",
        "b+asgLayXQ5Jq+se+q56jA==",
        "86ZDUI7vmp4MvNq3fvZrGQ==",
        "sEGFoYZ6GEg4Zocd+TiyfQ==",
        "6OOL72eXthgnJ1Hj4PfOQQ==",
        "g/ME+Sh1CAFboKrwkVb+5Q==",
        "Pw+xawUoX8xBYbX2yqqGWQ==",
        "k6vBalxYFhAvkPsF19t9gQ==",
        "b+asgLayXQ5Jq+se+q56jA==",
        "KKttwRz4w+AMJrZcB828WQ==",
        "vMdzZ33BXoyWVZnAPOBcrg==",
        "l8GDVI8w/ueHnNzdN1ODuQ==",
        "+yz9bnYYMnC0trJZGJwf6Q==",
      ]);
  });

  test("Blocks exact domain with and without protocol", () => {
    expect(
      isUrlBlocked(decryptAES("KZfBtpwjOpdSoqacRbz7og==", hashKey), null),
    ).toBe(true);
    expect(
      isUrlBlocked(
        decryptAES("TemsdmaA9kBK9cVJTaAmZksAh4WcS5779jwuGJ26ows=", hashKey),
        null,
      ),
    ).toBe(true);
    expect(
      isUrlBlocked(
        decryptAES("0pCVMPgc7+IMrLjIA5lFV0ttO4rKIA14yZBb+2FDG7I=", hashKey),
        null,
      ),
    ).toBe(true);
    expect(
      isUrlBlocked(
        decryptAES("m+PjIWE9E4GF3lA/B9cUMDj3smbHhZYOGxP74UTmd3M=", hashKey),
        null,
      ),
    ).toBe(true);
  });

  test("Blocks subdomains of a blocked domain", () => {
    expect(
      isUrlBlocked(
        decryptAES("m+PjIWE9E4GF3lA/B9cUMDj3smbHhZYOGxP74UTmd3M=", hashKey),
        null,
      ),
    ).toBe(true);
    expect(
      isUrlBlocked(
        decryptAES("o/ClKrW6Qo0uidbD2X8cVjj3smbHhZYOGxP74UTmd3M=", hashKey),
        null,
      ),
    ).toBe(true);
    expect(
      isUrlBlocked(
        decryptAES("Z53Ny7rvn7cBX/2bYpOZrRDosKfU7BiSM0OClb4bdWY=", hashKey),
        null,
      ),
    ).toBe(true);
  });

  test("Blocks different TLDs (BLOCKED-DOMAIN.pt, BLOCKED-DOMAIN.io)", () => {
    expect(
      isUrlBlocked(decryptAES("vUMeqQdqk7ajwczYBr6prA==", hashKey), null),
    ).toBe(true);
    expect(
      isUrlBlocked(decryptAES("WOjW9VwGwrPu846jDo6VQg==", hashKey), null),
    ).toBe(true);
    expect(
      isUrlBlocked(decryptAES("Ti3vVa6sRew3wyTZ7a/Yag==", hashKey), null),
    ).toBe(true);
    expect(
      isUrlBlocked(
        decryptAES("0pCVMPgc7+IMrLjIA5lFV5cYWcOWC5LGWwvlbCW2GH4=", hashKey),
        null,
      ),
    ).toBe(true);
  });

  test("Allows unrelated domains like whateverfacebook.com", () => {
    expect(isUrlBlocked("whateverfacebook.com", null)).toBe(false);
    expect(isUrlBlocked("https://whateverfacebook.com", null)).toBe(false);
  });

  test("Blocks other domains from the blocklist", () => {
    expect(
      isUrlBlocked(decryptAES("e3HFXLVgxhaVoadYpwb2BA==", hashKey), null),
    ).toBe(true);
    expect(
      isUrlBlocked(decryptAES("XS61fAjZb5JfAWsyzzOoCQ==", hashKey), null),
    ).toBe(true);
    expect(
      isUrlBlocked(decryptAES("Indtl4yxJMHCKBGF4KABCQ==", hashKey), null),
    ).toBe(true);
    expect(
      isUrlBlocked(decryptAES("86ZDUI7vmp4MvNq3fvZrGQ==", hashKey), null),
    ).toBe(true);
  });

  test("Allows allowed keywords URLs [developers.*, library.*, ads.*]", () => {
    expect(
      isUrlBlocked(
        decryptAES(
          "4H7Uyz6sSCwE3mne1SsGU+6gs7VssjM3e5C6qsyUPUnhsthhQp2bAQwZ9xSCJsjB",
          hashKey,
        ),
        null,
      ),
    ).toBe(false);
    expect(
      isUrlBlocked(
        decryptAES("rNA7JWR/voEnzAqpC4QJAYgZUratpaNBCBVujdFqDb0=", hashKey),
        null,
      ),
    ).toBe(false);
    expect(
      isUrlBlocked(
        decryptAES("ipHiDz83ep6vbIMee94+4XtxxVy1YMYWlaGnWKcG9gQ=", hashKey),
        null,
      ),
    ).toBe(false);
  });

  test("Should return false if the URL is invalid", () => {
    expect(isUrlBlocked("randomstring", null)).toBe(false);
    expect(isUrlBlocked("htp://bad.url", null)).toBe(false);
    expect(isUrlBlocked("", null)).toBe(false);
  });

  test("Should respect flags", () => {
    const decryptedDomain = decryptAES("e3HFXLVgxhaVoadYpwb2BA==", hashKey);

    expect(
      isUrlBlocked(decryptedDomain, {
        unblockedDomains: [decryptedDomain],
      }),
    ).toBe(false);
  });
});
