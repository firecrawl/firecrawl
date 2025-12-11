// @ts-check
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

// TEST_WEBSITE_URL required for deployment
const SITE_URL =
  (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
  process.env.TEST_WEBSITE_URL ||
  process.env.TEST_SUITE_WEBSITE ||
  "http://127.0.0.1:4321";

export default defineConfig({
  site: SITE_URL,
  output: 'static',
  integrations: [mdx(), sitemap()],
});
