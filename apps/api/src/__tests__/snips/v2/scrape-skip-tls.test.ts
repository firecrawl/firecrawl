import {
  ALLOW_TEST_SUITE_WEBSITE,
  HAS_PROXY,
  TEST_PRODUCTION,
  TEST_SUITE_WEBSITE,
  testIf,
} from "../lib";
import { Identity, idmux, scrapeTimeout, scrape, scrapeRaw } from "./lib";
import https from "node:https";

const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDCBJPpxbzPPuW8
DxlXh4JXR56Qq7hT74yiD+PzZ2OznSnfpZOA2kmQ30ztuGNstr/oE5Ixwarcp+9P
0tFz321TeN/6PNmSb0MPay8Q9xjvylMSao2ydATTyKumoF0nqZfHlgQNu6uYGan7
/8qmZcVIJ09oJP29vFTxP7S6Nk40klHlQyBAwtT+IoRqWvBztnu+5Xuy8cIQP4er
WoKySMuuVsnU8kwwM+QbFKGipD1jnK1xUGaaUtNpStNqnUKwNtW4jsMRjR/FapPF
p8hHxOGrgHtZJ7lqZHi60TdrnaPQjvwe+drswJIM9cIPkyzyd0FBlg+CPGkmlUAC
4w0MjknjAgMBAAECggEAUyiXJWnlpYa1/UcTe5rPWQ2Pfz67AO75/jSFZbx41XGV
kxBrCp2FTp0HYhTYOK6TzqskzELQM0efoT0hHWM0fsSea6lNMCCUQ7WTNNhUTeMQ
fCJDnatwrj2ipQazJt7f+WHpVuGLiOPnIeXfPDb+uhBvTpocUAi697RwiCfimVEl
wOcETyKjG+AdkHn1WqXdiduIQsmm3f8H4rJcGZo2OpyU33s0ZK2ReZhIkOEoyzp+
BX9cN8wnmiQc4M0DpcSOZYwn2OtLdsGirFasmhfDFMBgE+BS9W3knsMxd/zEtKTs
UxTK6bfdCNJkE8fR0H0ozViFvl61fcPuBvyDeTorwQKBgQD3oSbHo6MfZ53vNbBu
rfzoV35jnWUN34fkMo8YkGGIH1nPb7xlShg/zR6OL86wk6ADFO43UFEmbVDGxlCn
OscA04pfKP/Zvb9EDVr/j5Ix1LiFlATbjkPPqZj3IRdIih0ycjKFHR/OtbpPoINT
8CNs1/VYsgYh47t9fdApqdc4MQKBgQDIk4BGQfYc4Fzxpfhf7/IwA5AfTJip/H9f
XAxVFJhANymaUdDxar9D7VdoSQYOL2BD7KzT0JeeFwvwavnVc0jATAgmi81D+EaF
RX5DG5GoYSFD8aSnhu0dGF3QrPemaamlJdCYOd3of+b0wZhkCvVPcOy/bTdkOD9q
F3gZacWyUwKBgQCcbbjJtJ1/YT1rt0bVJCP3wg2db/g+Y0684RN0OQDjtKpPWA5z
DfNzmmgK+jhfY2JZkAdL+fjJhZTZfL3GZmMAKqHmq0e0jSEeJDGv70ozIGXQPEk1
SRGdRU3UD5tdv6HiFDHF1TgapMIlOwi7JZ+7SlE6znsBPZNbGvc82oWSgQKBgQDA
rVEQLNUrsCwYxoLuRiW1Efck2gPdZ31EMbx3Dq2jIlqIsAezogPSUPEicOOsRL6J
AZaUc1DywNjrPxh4f6Jnd6JsxOeOX7X+2F8OQDGQOp4mEr9FX0vwIzQb/cx4xA//
YXAci5osepF2lXK6x/wXMDd9PIF1eMMSOzFX2E/dmQKBgCAfdmgO9yU1K2esVb8B
vLPuFWNiQ1UvmDaV4DDc10JQH64R/yv7HsmRf5C+oPjUbgfXyn+SLdtaVKWtyDtk
8ajWWfZ2tqtXT31VdeJLjkABT+BU9H3u5YyrSPNIcGMgNSLjmb/DuWaclrIT6+hL
9g/pFxnn4mOVBYdX1GyDHhBD
-----END PRIVATE KEY-----`;

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJAMikv3+5vuPnMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCWxvY2FsaG9zdDAeFw0yNjA2MjIxNzQ0NThaFw0zNjA2MTkxNzQ0NThaMBQx
EjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAMIEk+nFvM8+5bwPGVeHgldHnpCruFPvjKIP4/NnY7OdKd+lk4DaSZDfTO24
Y2y2v+gTkjHBqtyn70/S0XPfbVN43/o82ZJvQw9rLxD3GO/KUxJqjbJ0BNPIq6ag
XSepl8eWBA27q5gZqfv/yqZlxUgnT2gk/b28VPE/tLo2TjSSUeVDIEDC1P4ihGpa
8HO2e77le7LxwhA/h6tagrJIy65WydTyTDAz5BsUoaKkPWOcrXFQZppS02lK02qd
QrA21biOwxGNH8Vqk8WnyEfE4auAe1knuWpkeLrRN2udo9CO/B752uzAkgz1wg+T
LPJ3QUGWD4I8aSaVQALjDQyOSeMCAwEAAaMeMBwwGgYDVR0RBBMwEYIJbG9jYWxo
b3N0hwR/AAABMA0GCSqGSIb3DQEBCwUAA4IBAQCqlZaFVPZ69S25OVzEPiRClsEe
NcpBmGwwEl3Yn+hmMXspBaubv2cHWKL+KRm3C9FicD/FqwTxjVqBmizZRFUETS/r
vTBEKE2lwXUVUbMZtCJ+NPszXh00PFjHO/Z/1poG+ZiMEXWB+nYJRDxUIt5BmK9W
GRxVxKHLId8rqcGyQk/hdjhg8xd9jINKN6T378ZHv1t+Z1WAWLwA4oZeiWwD7kEF
3IDQNbcl65aq2Qw6IDw+6bnCLc54A3BiU7miHDlNiP9rgjqf3cYzutTiem8L7DbY
SDXcSDjxdKJmewIopBnycE2rAU4/O7AivhFA0iqQ/KAD27s6l/7rtO+LH6za
-----END CERTIFICATE-----`;

describe("V2 Scrape skipTlsVerification Default", () => {
  let identity: Identity;
  let tlsServer: https.Server;
  let selfSignedUrl: string;

  beforeAll(async () => {
    identity = await idmux({
      name: "v2-scrape-skip-tls",
      concurrency: 100,
      credits: 1000000,
    });

    tlsServer = https.createServer(
      { key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT },
      (_req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<main><h1>Self-signed TLS fixture</h1></main>");
      },
    );

    await new Promise<void>(resolve => {
      tlsServer.listen(0, "127.0.0.1", resolve);
    });
    const address = tlsServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to start self-signed TLS fixture");
    }
    selfSignedUrl = `https://127.0.0.1:${address.port}/`;
  }, 10000);

  afterAll(async () => {
    if (!tlsServer) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      tlsServer.close(err => (err ? reject(err) : resolve()));
    });
  });

  testIf(!HAS_PROXY)(
    "should default skipTlsVerification to true in v2 API",
    async () => {
      const data = await scrape(
        {
          url: selfSignedUrl,
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.markdown).toContain("Self-signed TLS fixture");
    },
    scrapeTimeout,
  );

  testIf(!HAS_PROXY)(
    "should allow explicit skipTlsVerification: false override",
    async () => {
      const response = await scrapeRaw(
        {
          url: selfSignedUrl,
          skipTlsVerification: false,
          maxAge: 0,
        },
        identity,
      );

      if (response.status !== 500) {
        console.warn("Non-500 response:", JSON.stringify(response.body));
      }

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    },
    scrapeTimeout,
  );

  testIf(ALLOW_TEST_SUITE_WEBSITE)(
    "should work with valid HTTPS sites regardless of skipTlsVerification setting",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE, // NOTE: test website in self-host mode may not use TLS, need to check this out
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.markdown).toContain("Firecrawl");
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should support object screenshot format",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "screenshot", fullPage: false }],
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(typeof data.screenshot).toBe("string");
    },
    scrapeTimeout,
  );

  testIf(TEST_PRODUCTION)(
    "should support object screenshot format with fullPage",
    async () => {
      const data = await scrape(
        {
          url: TEST_SUITE_WEBSITE,
          formats: [{ type: "screenshot", fullPage: true }],
          maxAge: 0,
        },
        identity,
      );

      expect(data).toBeDefined();
      expect(data.screenshot).toBeDefined();
      expect(typeof data.screenshot).toBe("string");
    },
    scrapeTimeout,
  );
});
