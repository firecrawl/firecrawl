import { isSelfHosted } from "./deployment";

export const BLOCKLISTED_URL_MESSAGE = isSelfHosted()
  ? "This website is not currently supported. Please check your server configuration and logs for more details."
  : "This website is not currently supported. If you are part of an enterprise, please reach out to help@firecrawl.com to discuss the possibility of getting it activated on your account.";
