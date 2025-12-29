/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIRECRAWL_API_KEY: string
  readonly VITE_OPENAI_API_KEY?: string
  readonly VITE_ANTHROPIC_API_KEY?: string
  readonly VITE_API_ENDPOINT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
