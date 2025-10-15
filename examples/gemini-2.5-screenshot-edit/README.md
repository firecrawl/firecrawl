# Gemini 2.5 Flash (Nano Banana) Screenshot Editor

An intelligent screenshot editing tool that screenshots websites and transforms them using natural language. Simply describe what you want changed, and watch as Google's Gemini 2.5 Flash brings your vision to life.

## ✨ Key Features

### **Smart Screenshot Capture**

- **High-quality website screenshots** via Firecrawl's advanced capture technology
- **Automatic URL normalization** and validation (handles both http/https and plain domains)
- **Universal compatibility** with any publicly accessible website
- **Instant capture** with robust error handling and retry mechanisms

### **AI-Powered Visual Editing**

- **Natural Language Control**: Edit with plain English descriptions ("make it look cyberpunk", "add a minimalist design")
- **Advanced Image Understanding**: Gemini 2.5 Flash interprets visual context and maintains interface usability
- **Creative Transformations**: Add elements, change styles, modify layouts while preserving functionality
- **12+ Built-in Presets**: From minimalist clean to cyberpunk futuristic, vintage paper to holographic themes

### **Flexible Workflow Options**

- **Iterative Editing**: Build changes progressively with each edit building on the previous
- **Smart Redo System**: Try different approaches for the same edit or experiment with new styles
- **Version Branching**: Keep original while exploring alternatives - never lose your work
- **Reference Management**: Intelligent reference tracking for consistent editing workflows

### **Intelligent File Management**

- **Automatic timestamped filenames** (`edited_screenshot_v1_20241218-143502.png`)
- **Version tracking** (v1, v2, v3...) for progressive edits
- **Redo variant tracking** (-redo, -original-redo suffixes) for alternative versions
- **PNG format preservation** with high quality output
- **Organized output** with clear naming conventions for easy file management

## 🎨 Available Editing Presets

Choose from 12 professionally crafted editing styles:

| Style                    | Description                                                    | Best For                                              |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------- |
| **Minimalist Clean**     | Clean, minimal design with whitespace and simple elements      | Corporate sites, portfolios, clean interfaces         |
| **Retro 80s Vibe**       | Nostalgic neon colors, grid patterns, synthwave aesthetic      | Gaming sites, entertainment, creative projects        |
| **Cyberpunk Futuristic** | Dark theme with electric blue, neon green, glitch effects      | Tech sites, gaming, sci-fi themed content             |
| **Vintage Paper**        | Aged paper with sepia tones, coffee stains, vintage typography | Blogs, literary sites, historical content             |
| **Glass Morphism**       | Translucent glass-like elements with blur effects              | Modern apps, design showcases, premium sites          |
| **Neon Dark Mode**       | Deep black background with vibrant neon highlights             | Gaming platforms, developer tools, nightlife          |
| **Watercolor Artistic**  | Soft flowing colors with paint bleeding effects                | Art galleries, creative portfolios, lifestyle blogs   |
| **Brutalist Bold**       | Raw, high-contrast design with angular geometric shapes        | Architecture, bold brands, statement sites            |
| **Pastel Kawaii**        | Soft pastels with cute Japanese-inspired elements              | Fashion, lifestyle, creative communities              |
| **Art Deco Elegance**    | 1920s luxury with geometric patterns and gold accents          | Hotels, luxury brands, sophisticated services         |
| **Hand-Drawn Sketch**    | Pencil sketch aesthetic with organic, imperfect lines          | Creative agencies, personal blogs, artistic sites     |
| **Holographic Future**   | Iridescent rainbow gradients with prismatic effects            | Tech startups, innovative products, futuristic themes |

## 🔧 How It Works

1. **URL Input**: Enter any website URL (e.g., `https://example.com` or just `example.com`)
2. **Screenshot Capture**: Firecrawl's advanced engine captures high-resolution screenshots
3. **Style Selection**: Choose from 12 presets or enter a custom prompt
4. **AI Processing**: Gemini 2.5 Flash analyzes and transforms the image while preserving usability
5. **Auto-Save**: Results saved with automatic versioning and timestamps
6. **Interactive Workflow**: Continue with progressive edits, redo options, or start fresh

### Advanced Workflow Options

- **Progressive Editing**: Each edit builds on the previous result for compound transformations
- **Redo with Same Reference**: Try different prompts on the same base image
- **Back to Original**: Apply new styles to the original screenshot for comparison
- **Custom Prompts**: Unlimited creativity with natural language descriptions

## 📦 Setup

### Prerequisites

- **Python 3.8+** (Tested and optimized on Python 3.13+)
- **Google Gemini API Key** - [Get yours here](https://aistudio.google.com/apikey)
- **Firecrawl API Key** - [Sign up here](https://www.firecrawl.dev/app/api-keys)

### Getting Started

1. **Clone the repository**:

```bash
git clone <repository-url>
cd examples/gemini-2.5-screenshot-edit
```

2. **Set up a virtual environment** (recommended):

```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
```

3. **Install dependencies**:

```bash
pip install -r requirements.txt
```

4. **Configure environment variables**:
   Create a `.env` file in the project directory:

```bash
# Required API Keys
GEMINI_API_KEY=your_gemini_api_key_here
FIRECRAWL_API_KEY=your_firecrawl_api_key_here
```

### Usage

#### Basic Usage

```bash
python gemini-2.5-screenshot-edit.py
```

#### Example Session

```bash
$ python gemini-2.5-screenshot-edit.py
Enter a website URL: google.com
Capturing screenshot of https://google.com...
Screenshot captured successfully!

Choose an editing style for your screenshot:
❯ Minimalist Clean - Clean, minimal design with lots of whitespace
  Retro 80s Vibe - Nostalgic 1980s aesthetic with neon colors
  Cyberpunk Futuristic - Dark, high-tech aesthetic with neon accents
  # ... more options

Applying Minimalist Clean style...
Editing screenshot...
Image saved to edited_screenshot_v1_20241218-143502.png

What would you like to do next?
❯ Edit the screenshot further (custom prompt only)
  Redo last edit with same reference
  Redo with another style (back to original)
  Start over with a new URL
  Exit
```

## 🎯 Usage Examples

### Example 1: E-commerce Site Transformation

```
URL: amazon.com
Style: Minimalist Clean
Result: Clean, distraction-free product focus with enhanced whitespace
```

### Example 2: News Site Redesign

```
URL: cnn.com
Style: Vintage Paper
Custom Follow-up: "Make the headlines look like old newspaper headlines from the 1940s"
```

### Example 3: Tech Blog Enhancement

```
URL: techcrunch.com
Style: Cyberpunk Futuristic
Result: High-tech interface with neon accents and futuristic elements
```

## 🔍 Project Structure

```
gemini-2.5-screenshot-edit/
├── gemini-2.5-screenshot-edit.py  # Main application
├── editing_presets.py             # 12 built-in style presets
├── requirements.txt               # Python dependencies
├── .env                          # Environment variables (you create this)
├── README.md                     # This file
└── [generated images]            # Auto-saved edited screenshots
```

## 🚀 Advanced Features

### Custom Prompts

Beyond the 12 presets, create unlimited custom transformations:

- "Make it look like a retro terminal from the 1970s"
- "Transform this into a hand-painted watercolor with soft edges"
- "Apply a brutalist concrete aesthetic with harsh shadows"

### Version Management

- **Progressive versions**: v1 → v2 → v3 for iterative improvements
- **Redo variants**: Try different approaches without losing progress
- **Branch from original**: Compare multiple styles side-by-side

### Error Handling

- Robust URL validation and normalization
- Automatic retry on failed screenshots
- Graceful handling of API errors
- Clear feedback for troubleshooting
