import { gemini } from '@agentskit/adapters'
import { createRuntime } from '@agentskit/runtime'
import { firecrawl } from '@agentskit/tools/integrations'

const firecrawlApiKey = process.env.FIRECRAWL_API_KEY?.trim()
const googleApiKey = process.env.GOOGLE_API_KEY?.trim()
const targetUrl = process.env.TARGET_URL ?? 'https://www.firecrawl.dev/blog'

if (!firecrawlApiKey || !googleApiKey) {
  throw new Error('Set FIRECRAWL_API_KEY and GOOGLE_API_KEY in .env')
}

const runtime = createRuntime({
  adapter: gemini({
    apiKey: googleApiKey,
    model: 'gemini-2.5-flash',
  }),
  tools: firecrawl({ apiKey: firecrawlApiKey }),
  systemPrompt: [
    'You are a web research assistant.',
    'Use firecrawl_scrape before answering.',
    'Base every claim on the scraped page and say when the page does not contain the answer.',
  ].join(' '),
})

const result = await runtime.run(
  `Read ${targetUrl} and summarize its three most recent themes. Include the source URL.`,
)

console.log(result.content)
