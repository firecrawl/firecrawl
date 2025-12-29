# 🔥 Roast My Website

A web scraping and vision extraction demo from [Firecrawl](https://firecrawl.dev) that analyzes and roasts websites using AI.

![Roast My Website Demo](https://img.shields.io/badge/Powered%20by-Firecrawl-FF6B35?style=for-the-badge&logo=fire&logoColor=white)

## Features

- 🕷️ **Web Scraping** - Powered by Firecrawl to extract website content, screenshots, and design elements
- 🎨 **Design Analysis** - Automatically detects colors, typography, spacing, and layout patterns
- 🤖 **AI-Powered Roasting** - Uses OpenAI (or Firecrawl's AI) to generate witty critiques
- 🌶️ **Roast Levels** - Choose from Mild, Medium, or Spicy roasts
- 📸 **Full-Page Screenshots** - Visual preview of analyzed websites
- 🎯 **Detailed Feedback** - Covers design, UX, content, and overall impression

## Tech Stack

### Frontend
- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite** - Fast build tool
- **Tailwind CSS** - Styling
- **Radix UI** - Accessible components
- **React Markdown** - Formatted output

### Backend
- **Express** - API server
- **Firecrawl SDK** - Web scraping and vision extraction
- **OpenAI API** - AI-powered analysis (optional fallback to Firecrawl)

## Prerequisites

- Node.js 18+ and npm
- A [Firecrawl API key](https://firecrawl.dev) (required)
- An OpenAI API key (optional, for enhanced roasting)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/mendableai/firecrawl.git
cd firecrawl/apps/roast-my-website
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory:
```bash
cp .env.example .env
```

4. Add your API keys to `.env`:
```env
# Required
FIRECRAWL_API_KEY=fc-your-firecrawl-api-key

# Optional (for enhanced AI roasting)
OPENAI_API_KEY=sk-your-openai-api-key

# Server configuration (optional)
PORT=3002
```

## Usage

### Development Mode

Run both the frontend and backend servers concurrently:

```bash
npm run dev
```

This will start:
- Frontend dev server at `http://localhost:3001`
- Backend API server at `http://localhost:3002`

### Production Build

Build both client and server:

```bash
npm run build
```

Start the production server:

```bash
npm start
```

### Individual Scripts

```bash
# Run only the frontend
npm run dev:client

# Run only the backend server
npm run dev:server

# Build only the frontend
npm run build:client

# Build only the backend
npm run build:server

# Lint the code
npm run lint
```

## How It Works

1. **User Input** - Enter a website URL and select a roast level (Mild, Medium, or Spicy)

2. **Firecrawl Scraping** - The backend uses Firecrawl to:
   - Capture a full-page screenshot
   - Extract the website's markdown content
   - Analyze design elements (branding profile)
   - Get HTML structure

3. **AI Analysis** - The extracted data is sent to:
   - OpenAI GPT-4 (if API key provided) for detailed roasting
   - Or Firecrawl's extract endpoint as a fallback

4. **Roast Generation** - AI generates a comprehensive critique covering:
   - First impression
   - Design analysis (colors, typography, layout)
   - User experience assessment
   - Content and messaging review
   - Final verdict and rating

5. **Results Display** - The frontend shows:
   - Website screenshot
   - Formatted roast with markdown
   - Detected color palette
   - Design metrics

## API Endpoints

### `POST /api/roast`

Analyze and roast a website.

**Request Body:**
```json
{
  "url": "https://example.com",
  "roastLevel": "medium"
}
```

**Response:**
```json
{
  "roast": "# Your Website Roast\n\n...",
  "screenshot": "base64-encoded-image",
  "branding": {
    "colors": {
      "primary": "#FF5733",
      "secondary": "#333333"
    },
    "typography": { ... }
  }
}
```

### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "firecrawl": true,
  "openai": true
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIRECRAWL_API_KEY` | Yes | Your Firecrawl API key from https://firecrawl.dev |
| `OPENAI_API_KEY` | No | OpenAI API key for enhanced roasting (falls back to Firecrawl) |
| `PORT` | No | Server port (default: 3002) |
| `VITE_API_ENDPOINT` | No | Custom API endpoint (default: /api/roast) |

## Customization

### Adjust Roast Prompts

Edit the `getRoastPrompt()` function in `server/index.ts` to customize the AI prompts for different roast levels.

### Change Roast Levels

Modify the roast level options in `src/App.tsx` and update the corresponding prompts.

### Styling

The app uses Tailwind CSS. Customize colors and styles in:
- `tailwind.config.js` - Theme configuration
- `src/index.css` - Global styles and custom gradients

## Deployment

### Deploy to Vercel/Netlify (Frontend)

1. Build the frontend: `npm run build:client`
2. Deploy the `dist` folder

### Deploy Backend (Railway/Render/Heroku)

1. Set environment variables in your hosting platform
2. Use `npm run build:server && npm start` as the start command

### Deploy Full-Stack

Consider using platforms like:
- **Railway** - Automatic deployments with environment variables
- **Render** - Web services with background workers
- **Fly.io** - Global deployment with Docker

## Troubleshooting

### "Firecrawl API key not configured"
Make sure you've added `FIRECRAWL_API_KEY` to your `.env` file.

### "Failed to analyze website"
- Check that the URL is valid and accessible
- Verify your Firecrawl API key is active
- Check the server logs for detailed error messages

### CORS errors
The server is configured with CORS enabled. If you're running on different ports, update the CORS configuration in `server/index.ts`.

### API rate limits
Firecrawl has rate limits based on your plan. Consider implementing caching or rate limiting on your side.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is part of the Firecrawl repository and follows the same license.

## Credits

- Built with [Firecrawl](https://firecrawl.dev) - Web scraping API
- Powered by [OpenAI](https://openai.com) - AI analysis
- UI components from [Radix UI](https://radix-ui.com)
- Styled with [Tailwind CSS](https://tailwindcss.com)

## Support

- 📖 [Firecrawl Documentation](https://docs.firecrawl.dev)
- 💬 [Discord Community](https://discord.gg/firecrawl)
- 🐛 [Report Issues](https://github.com/mendableai/firecrawl/issues)

---

Made with 🔥 by the Firecrawl team
