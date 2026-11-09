# Verification

Do not stop at "the code compiles." Verify that a real Firecrawl request works.

## Fresh Project Smoke Test

Use the smallest request that proves auth, networking, and SDK wiring work:

- `/scrape` -> request one known URL
- `/search` -> run one small query with a limit of 1
- `/interact` -> start from `/scrape`, then run one minimal browser action

## Existing Project Smoke Test

Verify the integration in the actual place where it will run:

- start the app, worker, or script that owns the Firecrawl call
- trigger one request through the real integration path
- confirm the Firecrawl response is received and handled correctly
- confirm secrets are being read from the intended env source

## What Counts As Done

- credentials are loaded from `.env` or the deployment secret store
- the chosen endpoint succeeds once with real data
- the result reaches the intended application path
- obvious auth or base-URL mistakes are ruled out

If verification fails, debug auth, env loading, base URL, SDK install, or endpoint choice before moving on.
