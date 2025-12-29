import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import Firecrawl from '@mendable/firecrawl-js'
import OpenAI from 'openai'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3002

// Middleware
app.use(cors())
app.use(express.json())

// Initialize clients
const firecrawl = new Firecrawl({
  apiKey: process.env.FIRECRAWL_API_KEY || '',
})

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null

type RoastLevel = 'mild' | 'medium' | 'spicy'

function getRoastPrompt(level: RoastLevel): string {
  const basePrompt = `You are a witty website design critic. Analyze this website and provide a constructive but entertaining critique.`

  const levelInstructions = {
    mild: `Be gentle and encouraging. Focus on constructive feedback with a light, friendly tone. Highlight strengths before mentioning areas for improvement. Keep it fun but supportive.`,
    medium: `Be honest and direct with a touch of humor. Point out both strengths and weaknesses clearly. Use witty observations and clever comparisons. Don't hold back, but keep it professional.`,
    spicy: `Go full roast mode! Be brutally honest and hilariously savage. Use sharp wit, clever burns, and don't pull any punches. Make it entertaining and memorable, but focus on genuine design issues.`,
  }

  return `${basePrompt}

${levelInstructions[level]}

Provide your critique in the following structure:
1. **First Impression** - Your immediate reaction to the website
2. **Design Analysis** - Evaluate colors, typography, layout, and visual hierarchy
3. **User Experience** - Assess navigation, usability, and overall UX
4. **Content & Messaging** - Review the copy, messaging clarity, and brand voice
5. **The Verdict** - Final rating and summary

Use markdown formatting. Be specific and reference actual design elements when possible.`
}

app.post('/api/roast', async (req, res) => {
  try {
    const { url, roastLevel = 'medium' } = req.body

    if (!url) {
      return res.status(400).json({ message: 'URL is required' })
    }

    if (!process.env.FIRECRAWL_API_KEY) {
      return res.status(500).json({
        message: 'Firecrawl API key not configured. Please set FIRECRAWL_API_KEY environment variable.',
      })
    }

    console.log(`🔥 Roasting ${url} at ${roastLevel} level...`)

    // Step 1: Scrape the website with Firecrawl
    console.log('📸 Capturing website screenshot and extracting branding...')
    const scrapeResult = await firecrawl.scrape(url, {
      formats: [
        { type: 'screenshot', fullPage: true, quality: 80 },
        'markdown',
        'branding',
        'html',
      ],
    })

    console.log('✅ Scrape complete!')

    // Step 2: Prepare analysis data
    const analysisData = {
      url,
      markdown: scrapeResult.markdown?.substring(0, 5000) || '', // Limit content
      branding: scrapeResult.branding,
      hasScreenshot: !!scrapeResult.screenshot,
    }

    console.log('🤖 Generating AI roast...')

    // Step 3: Generate roast with AI
    let roastText = ''

    if (openai) {
      // Use OpenAI for roasting
      const systemPrompt = getRoastPrompt(roastLevel as RoastLevel)

      const userPrompt = `Analyze and roast this website:

**URL:** ${url}

**Design Profile:**
${JSON.stringify(analysisData.branding, null, 2)}

**Page Content Preview:**
${analysisData.markdown.substring(0, 2000)}

Provide your roast following the structure in the system prompt.`

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1500,
        temperature: 0.8,
      })

      roastText = completion.choices[0]?.message?.content || 'Failed to generate roast'
    } else {
      // Fallback: Use Firecrawl's extract with prompt
      console.log('ℹ️ OpenAI not configured, using Firecrawl extract...')

      const extractResult = await firecrawl.extract({
        urls: [url],
        prompt: `${getRoastPrompt(roastLevel as RoastLevel)}

Analyze the website and provide a detailed roast/critique following the structure mentioned.`,
        schema: {
          type: 'object',
          properties: {
            roast: {
              type: 'string',
              description: 'The complete roast/critique of the website',
            },
          },
          required: ['roast'],
        },
      })

      roastText = extractResult?.roast || 'Failed to generate roast'
    }

    console.log('✅ Roast generated!')

    // Return the result
    res.json({
      roast: roastText,
      screenshot: scrapeResult.screenshot,
      branding: scrapeResult.branding,
    })
  } catch (error) {
    console.error('❌ Error:', error)
    res.status(500).json({
      message: error instanceof Error ? error.message : 'Failed to analyze website',
    })
  }
})

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    firecrawl: !!process.env.FIRECRAWL_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
  })
})

app.listen(PORT, () => {
  console.log(`🔥 Roast My Website API running on port ${PORT}`)
  console.log(`🔑 Firecrawl: ${process.env.FIRECRAWL_API_KEY ? '✅' : '❌'}`)
  console.log(`🤖 OpenAI: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`)
})
