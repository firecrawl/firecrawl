# Stripe Projects

Use this path when the project already uses [Stripe Projects](https://docs.stripe.com/projects): a `.projects/` directory exists at the repo root, or `stripe projects status` succeeds. It provisions a Firecrawl account and API key from the terminal, with no browser step.

## Step 1: Confirm the slug

```bash
stripe projects catalog firecrawl --json
```

The service to add is `firecrawl/api`. Do not guess slugs; copy them from the catalog.

## Step 2: Provision

```bash
stripe projects add firecrawl/api --name firecrawl
```

`--name firecrawl` makes the CLI write `FIRECRAWL_API_KEY`. Without it the key lands in `FIRECRAWL_API_API_KEY`, which the Firecrawl SDKs do not read.

The CLI also writes `FIRECRAWL_API_BASE_URL` and `FIRECRAWL_DOCUMENTATION_URL`. Treat both as informational. The SDKs read `FIRECRAWL_API_URL`, and only for self-hosted deployments; a Stripe-provisioned account always uses the hosted API at `https://api.firecrawl.dev`, which is the SDK default, so leave `FIRECRAWL_API_URL` unset and do not copy `FIRECRAWL_API_BASE_URL` into it.

Provisioning accepts the [Firecrawl Terms of Service](https://www.firecrawl.dev/terms-of-service) on the human's behalf. Confirm with them before running non-interactively with `--no-interactive --accept-tos`.

The account is keyed on the Stripe account's email. An email that already has a Firecrawl account is reused; a new email gets a new account on the Free plan.

## Step 3: Pull credentials

```bash
stripe projects env --pull
```

Then use `FIRECRAWL_API_KEY` from the environment. Do not read or edit `.env` by hand; the Stripe CLI manages that file.

## Paid plans

`stripe projects upgrade firecrawl` moves the account to Hobby, Standard, or Growth and charges the payment method on the Stripe account. Leave this to the human: ask them to run it and pick the plan and billing interval.

## If something fails

- `Provider connection requires re-authentication`: run `stripe projects link firecrawl`, then retry.
- `Unknown provider or category: firecrawl`: run `stripe plugin upgrade projects`, then `stripe projects catalog firecrawl --refresh`.

Full guide: https://docs.firecrawl.dev/integrations/stripe-projects
