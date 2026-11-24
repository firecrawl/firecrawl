# Firecrawl + Gemini 3.1 Flash-Lite Image CLI Editor 🎨🔥

A production-ready Python CLI that combines Firecrawl's powerful screenshot capabilities with Google's Gemini 3.1 Flash-Lite Image model (`gemini-3.1-flash-lite-image`) for advanced AI-powered image editing, artistic style transfer, and creative transformations.

## 🌟 Key Features

### Core Capabilities
- **Website Screenshot Capture**: High-quality screenshots using Firecrawl API
- **Text-to-Image Generation**: Create images from descriptions
- **Advanced Style Transfer**: Van Gogh, Monet, Picasso, and 10+ artistic styles
- **Multi-Image Composition**: Blend multiple screenshots/images
- **Iterative Refinement**: Apply progressive enhancements
- **Batch Processing**: Process multiple URLs with same transformation
- **Creative Editing**: Custom AI-powered transformations

### Production Features
- Robust error handling for invalid URLs, API failures, and rate limits
- Verbose mode for debugging
- Flexible output options
- Mobile and viewport-only capture modes
- Intermediate step saving for refinements

## 🚀 Quick Start

### 1. Installation

```bash
# Clone or download this example
git clone https://github.com/firecrawl/firecrawl.git
cd firecrawl/examples/gemini-2.5-screenshot-editor

# Install dependencies
pip install -r requirements.txt
```

### 2. API Key Setup

```bash
# Copy the example env file
cp .env.example .env

# Edit .env and add your keys:
# FIRECRAWL_API_KEY=your_firecrawl_api_key
# GEMINI_API_KEY=your_gemini_api_key
```

#### Get Your API Keys:
- **Firecrawl**: Sign up at [firecrawl.dev](https://firecrawl.dev) to get your API key
- **Gemini**: Get your key from [Google AI Studio](https://aistudio.google.com/)

### 3. Basic Usage

```bash
# Transform a website into Van Gogh style
python cli.py https://github.com --artistic van_gogh

# Apply cyberpunk style to any website
python cli.py https://example.com --style cyberpunk

# Generate image from text
python cli.py --generate "A futuristic dashboard with neon colors"
```

## 📚 Comprehensive Examples

### 🎯 Basic Argument Examples

```bash
# --edit: Custom transformation
python cli.py https://github.com --edit "Make it look like a cyberpunk interface"

# --style: Preset style
python cli.py https://stripe.com --style vintage

# --artistic: Famous art style
python cli.py https://apple.com --artistic van_gogh

# --generate: Text-to-image (no URL needed)
python cli.py --generate "Modern e-commerce website with dark theme"

# --mobile: Mobile viewport
python cli.py https://tailwindcss.com --mobile

# --viewport-only: No scrolling
python cli.py https://example.com --viewport-only

# --output: Custom filename
python cli.py https://site.com --style cyberpunk --output my_result.png

# --verbose: Debug information
python cli.py https://github.com --artistic monet --verbose

# --high-quality: Maximum quality
python cli.py https://portfolio.com --edit "Make artistic" --high-quality

# --refine: Step-by-step improvements
python cli.py https://example.com --refine "Add dark theme" "Add neon accents"

# --composite: Combine multiple sites
python cli.py https://github.com https://gitlab.com --composite "Merge these designs"

# --batch: Process multiple URLs
python cli.py --batch urls.txt --style cyberpunk

# --save-intermediates: Save each refinement step
python cli.py https://site.com --refine "Step 1" "Step 2" --save-intermediates

# --output-dir: Custom directory for outputs
python cli.py --batch urls.txt --artistic monet --output-dir art_gallery

# --preserve-content: Keep original layout
python cli.py https://apple.com --artistic van_gogh --preserve-content

# --wait: Wait before screenshot
python cli.py https://slow-site.com --wait 10 --style minimal
```

### 🎨 Artistic Style Transfer

Transform website screenshots into famous art styles:

```bash
# Van Gogh's Starry Night style
python cli.py https://github.com --artistic van_gogh --output github_van_gogh.png

# Monet's impressionist style
python cli.py https://stripe.com --artistic monet --preserve-content

# Picasso's cubist style
python cli.py https://notion.so --artistic picasso

# Andy Warhol's pop art
python cli.py https://apple.com --artistic warhol

# Japanese woodblock print
python cli.py https://tailwindcss.com --artistic ukiyo_e
```

**Available Artistic Styles:**
- `van_gogh` - Swirling brushstrokes, dramatic blues and yellows
- `monet` - Soft impressionist colors
- `picasso` - Cubist geometric shapes
- `warhol` - Pop art with bold colors
- `dali` - Surrealist dreamlike distortions
- `ukiyo_e` - Japanese woodblock print style
- `watercolor` - Delicate translucent painting
- `oil_painting` - Classical realistic textures
- `pencil_sketch` - Detailed pencil drawing
- `comic_book` - Bold outlines and vibrant colors

### 🔄 Iterative Refinement

Apply progressive transformations to achieve complex results:

```bash
# Multi-step enhancement (saves intermediates to current directory)
python cli.py https://example.com --refine \
  "Make it futuristic with neon glows" \
  "Add cyberpunk elements" \
  "Enhance contrast and add dramatic lighting" \
  --save-intermediates

# Save intermediates to specific directory
python cli.py https://example.com --refine \
  "Make it futuristic with neon glows" \
  "Add cyberpunk elements" \
  "Enhance contrast and add dramatic lighting" \
  --save-intermediates --output-dir refinement_steps

# Progressive style evolution
python cli.py https://github.com --refine \
  "Add vintage film grain" \
  "Apply sepia tones" \
  "Add old photograph border" \
  "Make it look 100 years old"
```

### 🎭 Multi-Image Composition

Combine multiple screenshots or images:

```bash
# Merge two website designs
python cli.py https://github.com https://gitlab.com \
  --composite "Blend these two interfaces into a unified design"

# Create a collage
python cli.py https://google.com https://bing.com https://duckduckgo.com \
  --composite "Create an artistic collage of search engines"

# Combine local images with screenshots
python cli.py https://example.com local_image.png \
  --composite "Merge website design with provided image"
```

### 📦 Batch Processing

Process multiple URLs with the same transformation:

```bash
# Create a file with URLs (one per line)
echo "https://github.com
https://gitlab.com
https://bitbucket.org" > urls.txt

# Apply same style to all
python cli.py --batch urls.txt --edit "Apply cyberpunk style"

# Batch artistic transformation
python cli.py --batch urls.txt --artistic van_gogh
```

### 🎯 Custom Creative Transformations

```bash
# Transform website into specific artistic vision
python cli.py https://github.com --edit \
  "Transform into Vincent van Gogh's Starry Night style with swirling brushstrokes"

# Creative reinterpretation
python cli.py https://apple.com --edit \
  "Reimagine as a retro 1980s computer advertisement"

# Specific style instructions
python cli.py https://notion.so --edit \
  "Convert to hand-drawn wireframe sketch with annotations"
```

### 📱 Mobile and Viewport Options

```bash
# Mobile viewport capture
python cli.py https://tailwindcss.com --mobile --style minimal

# Viewport only (no scrolling)
python cli.py https://stripe.com --viewport-only --artistic watercolor

# Full page with custom wait time
python cli.py https://github.com --wait 5 --style cyberpunk
```

### 🖼️ Pure Text-to-Image Generation

Generate images without website input:

```bash
# Website design concepts
python cli.py --generate "Modern SaaS landing page with gradients"

# With artistic style
python cli.py --generate "E-commerce homepage" --artistic van_gogh

# Creative concepts
python cli.py --generate \
  "Futuristic dashboard with holographic elements and data visualizations"
```

## 🛠️ Advanced Options

### Output File Behavior
- **Default**: Files are saved in the current directory where the command is run
- **--output**: Specify exact filename and path for the final result
- **--output-dir**: Specify directory for batch operations or intermediate refinement steps
- **--save-intermediates**: When used with --refine:
  - Without --output-dir: Saves refinement_1.png, refinement_2.png, etc. in current directory
  - With --output-dir: Saves intermediate files in the specified directory

### Verbose Mode
```bash
# See detailed processing information
python cli.py https://example.com --artistic van_gogh --verbose
```

### Custom Output Paths
```bash
# Specify output file
python cli.py https://github.com --style cyberpunk --output custom_name.png

# Batch output directory
python cli.py --batch urls.txt --output-dir my_outputs
```

### Preserve Content
```bash
# Maintain original composition in style transfer
python cli.py https://example.com --artistic van_gogh --preserve-content
```

## 📋 Full Command Reference

```
python cli.py [urls...] [options]
```

### All Arguments

| Argument | Type | Description | Example |
|----------|------|-------------|---------|
| **urls** | positional | Website URLs or image files to process | `https://github.com local.png` |
| **--generate** | string | Generate image from text prompt (no URL needed) | `--generate "Modern dashboard design"` |
| **--style** | choice | Apply preset style transformation | `--style cyberpunk` |
| **--artistic** | choice | Apply famous artistic style transfer | `--artistic van_gogh` |
| **--edit** | string | Custom editing instruction for screenshot | `--edit "Make it look vintage"` |
| **--composite** | string | Combine multiple images/URLs into one | `--composite "Merge these designs"` |
| **--refine** | list | Apply iterative refinements step by step | `--refine "Add neon" "Enhance contrast"` |
| **--output, -o** | path | Specify output filename | `--output result.png` |
| **--output-dir** | path | Directory for batch operations or intermediate refinement steps (defaults to current directory if not specified) | `--output-dir results/` |
| **--batch** | file | Process multiple URLs from a text file | `--batch urls.txt` |
| **--compose** | list | Additional images to include in composition | `--compose img1.png img2.png` |
| **--mobile** | flag | Capture mobile viewport | `--mobile` |
| **--viewport-only** | flag | Capture only visible viewport (no scrolling) | `--viewport-only` |
| **--wait** | int | Wait time in seconds before screenshot | `--wait 5` |
| **--preserve-content** | flag | Preserve original composition in style transfer | `--preserve-content` |
| **--save-intermediates** | flag | Save intermediate steps in refinements (saves to current dir or --output-dir if specified) | `--save-intermediates` |
| **--high-quality** | flag | Generate maximum quality images (default: enabled) | `--high-quality` |
| **--verbose, -v** | flag | Show detailed processing information | `--verbose` |
| **--firecrawl-url** | url | Custom Firecrawl API endpoint | `--firecrawl-url https://api.custom.com` |

### Available Preset Styles (--style)
- `cyberpunk` - Futuristic neon colors and glowing effects
- `vintage` - Sepia tones with aged, retro appearance
- `artistic` - Oil painting style with enhanced colors
- `dramatic` - High contrast cinematic look
- `minimal` - Clean, simplified aesthetic

### Available Artistic Styles (--artistic)
- `van_gogh` - Starry Night swirling brushstrokes
- `monet` - Impressionist soft colors
- `picasso` - Cubist geometric shapes
- `warhol` - Pop art bold colors
- `dali` - Surrealist dreamlike distortions
- `ukiyo_e` - Japanese woodblock print style
- `watercolor` - Delicate translucent painting
- `oil_painting` - Classical realistic textures
- `pencil_sketch` - Detailed pencil drawing
- `comic_book` - Bold outlines and vibrant colors

## 🏆 Production Best Practices

### Error Handling
The CLI includes comprehensive error handling for:
- Invalid URLs and network failures
- API rate limits and authentication errors
- Image processing failures
- File system permissions
- Malformed responses

### Performance Optimization
- Efficient batch processing
- Proper timeout handling
- Memory-efficient image processing
- Graceful fallbacks

### Code Quality
- Clean function separation
- Type hints for better IDE support
- Comprehensive docstrings
- Modular architecture

## 🔧 Troubleshooting

### Common Issues and Solutions

| Issue | Solution |
|-------|----------|
| "API key not found" | Check `.env` file has correct keys |
| "Screenshot failed" | Verify URL is accessible and Firecrawl has credits |
| "No image generated" | Try rephrasing prompt or check Gemini quota |
| "Style transfer failed" | Ensure image is valid and try simpler prompt |

### Debug Mode
```bash
# Enable verbose output for debugging
python cli.py https://example.com --verbose --artistic van_gogh
```

## 📦 Requirements

- Python 3.8+
- Active Firecrawl API key
- Active Google Gemini API key
- Internet connection

## 🤝 Contributing

This tool demonstrates the integration between Firecrawl and Gemini APIs. Feel free to:
- Add new artistic styles
- Implement additional features
- Improve error handling
- Enhance documentation

## 📄 License

MIT License - See LICENSE file for details

## 🎯 Use Cases

Perfect for:
- **Designers**: Quick mockup variations and style experiments
- **Developers**: Automated screenshot processing for documentation
- **Marketers**: Creative content generation from existing websites
- **Artists**: Transform web designs into artistic pieces
- **Researchers**: Batch process and analyze website designs

## 🚦 API Limits

- **Firecrawl**: Check your plan's screenshot limits
- **Gemini**: 2 QPM (queries per minute) for free tier
- **Image Size**: Gemini supports up to 20MB images

## 📞 Support

- **Firecrawl Issues**: [firecrawl.dev/support](https://firecrawl.dev)
- **Gemini Documentation**: [ai.google.dev](https://ai.google.dev)
- **GitHub Issues**: Report bugs in the Firecrawl repository

---

Built with ❤️ for the Firecrawl community | [GitHub Issue #2169](https://github.com/firecrawl/firecrawl/issues/2169)