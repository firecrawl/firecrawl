# Project Setup

For hosted Firecrawl, add this to `.env`:

```dotenv
FIRECRAWL_API_KEY=fc-...
```

For self-hosted Firecrawl, add:

```dotenv
FIRECRAWL_API_KEY=fc-...
FIRECRAWL_API_URL=https://your-firecrawl-instance.example.com
```

Project setup guidance:

- Keep the key in environment variables or the platform secret manager.
- Do not hardcode credentials in source files.
- If the app has separate environments, mirror the key setup across development, preview, and production as needed.
