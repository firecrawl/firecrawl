import {
  ALLOW_TEST_SUITE_WEBSITE,
  concurrentIf,
  TEST_SUITE_WEBSITE,
} from "../lib";
import { expectMapToSucceed, map, idmux, Identity } from "./lib";

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "map",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

// TODO: is map meant for self-host?
describe("Map tests", () => {
  const base = TEST_SUITE_WEBSITE;

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "basic map succeeds",
    async () => {
      const response = await map(
        {
          url: base,
        },
        identity,
      );

      expectMapToSucceed(response);
    },
    60000,
  );

  concurrentIf(ALLOW_TEST_SUITE_WEBSITE)(
    "times out properly",
    async () => {
      const response = await map(
        {
          url: base,
          timeout: 1,
        },
        identity,
      );

      expect(response.statusCode).toBe(408);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("The map operation timed out");
    },
    10000,
  );

  it.concurrent(
    "handles query parameters correctly",
    async () => {
      let response = await map(
        {
          url: "https://www.hfea.gov.uk",
          sitemapOnly: true,
          useMock: "map-query-params",
          ignoreQueryParameters: false,
        },
        identity,
      );

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
      expect(
        response.body.links.some(x =>
          x.match(
            /^https:\/\/www\.hfea\.gov\.uk\/choose-a-clinic\/clinic-search\/results\/?\?options=\d+$/,
          ),
        ),
      ).toBe(true);
    },
    60000,
  );
});
