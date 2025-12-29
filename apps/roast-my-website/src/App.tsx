import { useState } from 'react'
import { Flame, Loader2 } from 'lucide-react'
import { Button } from './components/Button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/Select'
import { analyzeWebsite, RoastLevel } from './api/roast'
import ReactMarkdown from 'react-markdown'

interface RoastResult {
  roast: string
  screenshot?: string
  branding?: {
    colors?: Record<string, string>
    typography?: Record<string, any>
  }
}

function App() {
  const [url, setUrl] = useState('https://coconut.com/')
  const [roastLevel, setRoastLevel] = useState<RoastLevel>('medium')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<RoastResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleRoast = async () => {
    if (!url) {
      setError('Please enter a valid URL')
      return
    }

    setLoading(true)
    setError(null)
    setResult(null)

    try {
      const roastResult = await analyzeWebsite(url, roastLevel)
      setResult(roastResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to roast website. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const getRoastEmoji = (level: RoastLevel) => {
    switch (level) {
      case 'mild':
        return '🌶️'
      case 'medium':
        return '🌶️🌶️'
      case 'spicy':
        return '🌶️🌶️🌶️'
      default:
        return '🌶️🌶️'
    }
  }

  return (
    <div className="gradient-bg min-h-screen">
      <div className="container max-w-4xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-6xl md:text-7xl font-bold mb-4">
            <span className="text-red-500 handwritten">Roast</span>
            <br />
            <span className="text-gray-700 handwritten">My Website</span>
          </h1>
        </div>

        {/* Input Form */}
        <div className="bg-white rounded-lg shadow-lg p-8 mb-8">
          <div className="space-y-6">
            <div>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://coconut.com/"
                className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent text-lg"
                disabled={loading}
              />
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-4">
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <label className="text-gray-700 font-medium whitespace-nowrap">
                  Choose your roast level:
                </label>
                <Select
                  value={roastLevel}
                  onValueChange={(value) => setRoastLevel(value as RoastLevel)}
                  disabled={loading}
                >
                  <SelectTrigger className="w-[180px] handwritten text-base">
                    <SelectValue placeholder="Select level" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="mild" className="handwritten">
                      Mild 🌶️
                    </SelectItem>
                    <SelectItem value="medium" className="handwritten">
                      Medium 🌶️🌶️
                    </SelectItem>
                    <SelectItem value="spicy" className="handwritten">
                      Spicy 🌶️🌶️🌶️
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={handleRoast}
                disabled={loading || !url}
                className="bg-red-500 hover:bg-red-600 text-white px-8 py-6 text-lg rounded-full handwritten shadow-lg transition-transform hover:scale-105 disabled:hover:scale-100 w-full sm:w-auto sm:ml-auto"
                size="lg"
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Roasting...
                  </>
                ) : (
                  <>
                    Get Roasted <Flame className="ml-2 h-5 w-5" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="bg-red-50 border-2 border-red-300 rounded-lg p-6 mb-8 fade-in">
            <p className="text-red-700 font-medium">{error}</p>
          </div>
        )}

        {/* Results */}
        {result && (
          <div className="bg-white rounded-lg shadow-lg p-8 mb-8 fade-in">
            <div className="flex items-center gap-2 mb-6">
              <Flame className="h-6 w-6 text-red-500" />
              <h2 className="text-2xl font-bold text-gray-800">
                Your Website Roast {getRoastEmoji(roastLevel)}
              </h2>
            </div>

            {/* Screenshot */}
            {result.screenshot && (
              <div className="mb-6 rounded-lg overflow-hidden border-2 border-gray-200">
                <img
                  src={`data:image/png;base64,${result.screenshot}`}
                  alt="Website screenshot"
                  className="w-full h-auto"
                />
              </div>
            )}

            {/* Roast Content */}
            <div className="prose prose-lg max-w-none">
              <ReactMarkdown
                components={{
                  h1: ({ children }) => (
                    <h1 className="text-3xl font-bold text-gray-800 mb-4">
                      {children}
                    </h1>
                  ),
                  h2: ({ children }) => (
                    <h2 className="text-2xl font-bold text-gray-700 mb-3 mt-6">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }) => (
                    <h3 className="text-xl font-semibold text-gray-700 mb-2 mt-4">
                      {children}
                    </h3>
                  ),
                  ul: ({ children }) => (
                    <ul className="list-disc list-inside space-y-2 mb-4">
                      {children}
                    </ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="list-decimal list-inside space-y-2 mb-4">
                      {children}
                    </ol>
                  ),
                  li: ({ children }) => (
                    <li className="text-gray-700">{children}</li>
                  ),
                  p: ({ children }) => (
                    <p className="text-gray-700 mb-4 leading-relaxed">
                      {children}
                    </p>
                  ),
                  strong: ({ children }) => (
                    <strong className="font-bold text-gray-900">
                      {children}
                    </strong>
                  ),
                }}
              >
                {result.roast}
              </ReactMarkdown>
            </div>

            {/* Branding Colors Preview */}
            {result.branding?.colors && (
              <div className="mt-8 pt-6 border-t border-gray-200">
                <h3 className="text-lg font-semibold text-gray-700 mb-3">
                  Detected Color Palette
                </h3>
                <div className="flex flex-wrap gap-3">
                  {Object.entries(result.branding.colors).map(
                    ([name, color]) => (
                      <div key={name} className="flex items-center gap-2">
                        <div
                          className="w-12 h-12 rounded border-2 border-gray-300"
                          style={{ backgroundColor: color }}
                          title={color}
                        />
                        <span className="text-sm text-gray-600 capitalize">
                          {name}
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="text-center mt-12">
          <p className="text-gray-600 text-sm">
            A web scraping and vision extraction demo from{' '}
            <a
              href="https://firecrawl.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="text-red-500 hover:text-red-600 font-semibold"
            >
              Firecrawl
            </a>{' '}
            <Flame className="inline h-4 w-4 text-red-500" />
          </p>
        </div>
      </div>
    </div>
  )
}

export default App
