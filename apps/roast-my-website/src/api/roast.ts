export type RoastLevel = 'mild' | 'medium' | 'spicy'

interface RoastResult {
  roast: string
  screenshot?: string
  branding?: {
    colors?: Record<string, string>
    typography?: Record<string, any>
  }
}

const API_ENDPOINT = import.meta.env.VITE_API_ENDPOINT || '/api/roast'

export async function analyzeWebsite(
  url: string,
  roastLevel: RoastLevel
): Promise<RoastResult> {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      roastLevel,
    }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Failed to roast website' }))
    throw new Error(error.message || 'Failed to roast website')
  }

  return response.json()
}
