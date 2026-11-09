# Auth Flow

Use this browser flow when the user does not already have a Firecrawl API key.

## Step 1: Generate auth parameters

```bash
SESSION_ID=$(openssl rand -hex 32)
CODE_VERIFIER=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | head -c 43)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
```

## Step 2: Ask the user to open this URL

```text
https://www.firecrawl.dev/cli-auth?code_challenge=$CODE_CHALLENGE&source=coding-agent#session_id=$SESSION_ID
```

The user completes the browser authorization flow. If successful, the API key becomes available through the polling endpoint.

## Step 3: Poll for completion

```http
POST https://www.firecrawl.dev/api/auth/cli/status
Content-Type: application/json

{"session_id":"$SESSION_ID","code_verifier":"$CODE_VERIFIER"}
```

Responses:

- `{"status":"pending"}` - continue polling
- `{"status":"complete","apiKey":"fc-...","teamName":"..."}`

## Step 4: Save the key

```bash
echo "FIRECRAWL_API_KEY=fc-..." >> .env
```
