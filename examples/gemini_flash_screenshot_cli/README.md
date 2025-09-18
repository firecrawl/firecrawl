
# Website Screenshot Editor CLI

A Python CLI tool that combines **[Firecrawl](https://firecrawl.dev/)** (for capturing high-quality website screenshots) with **Google’s Gemini 2.5 Flash API** (for AI-powered image editing).  

This tool lets you capture any webpage screenshot and instantly transform it into **dark mode, wireframes, mobile mockups, social previews, accessibility simulations, redesigns, and more**. Perfect for designers, developers, and product teams who need quick visual iterations.

## Features

Supported transformations:

- **dark_mode** – Convert screenshot into a sleek dark mode design  
- **light_mode** – Convert screenshot into a clean light mode design  
- **mobile_mockup** – Place screenshot inside a mobile phone (default: iPhone)  
- **tablet_mockup** – Place screenshot inside a laptop/tablet mockup (default: MacBook)  
- **wireframe** – Convert screenshot into a black-and-white wireframe  
- **hero_section** – Extract and enhance the hero section  
- **highlight_cta** – Highlight CTAs, menus, and footers with arrows and labels  
- **focus_mode** – Blur sidebars/ads and highlight only the main content  
- **accessibility** – Simulate color blindness (default: protanopia)  
- **localization** – Translate all visible text into another language (default: Spanish `es`)  
- **privacy_blur** – Blur sensitive info (emails, phone numbers, usernames, payment details)  
- **brand_color_swap** – Recolor UI elements with a new brand color (default: `#FF5733`)  
- **social_preview** – Place screenshot in a social media preview (default: Twitter, title: *Now Live!*)  
- **redesign_material** – Redesign using Google’s Material UI (MD3)  
- **redesign_bootstrap** – Redesign using Bootstrap 5 principles  
- **redesign_minimal** – Redesign with a modern minimalistic look  


## Setup Instructions

### 1. Clone Repository

```bash
git clone https://github.com/your-username/screenshot-editor-cli.git
cd screenshot-editor-cli
````

### 2. Create Virtual Environment

```bash
python3 -m venv venv
source venv/bin/activate   # Mac/Linux
venv\Scripts\activate      # Windows
```

### 3. Install Dependencies

```bash
pip install -r requirements.txt
```

### 4. Configure API Keys

Create a `.env` file in the project root:

```env
FIRECRAWL_API_KEY=your_firecrawl_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
```

* Get a [Firecrawl API Key](https://firecrawl.dev/)
* Get a [Google Gemini API Key](https://ai.google.dev/)

---

## Usage Examples

### Capture a Website in Dark Mode

```bash
python main.py --url https://example.com --feature dark_mode
```

### Run Multiple Features with a Preset

```bash
python main.py --url https://example.com --preset ux_review
```

Presets available:

* **ux\_review** → dark\_mode, wireframe, highlight\_cta
* **marketing** → social\_preview, mobile\_mockup, redesign\_minimal
* **accessibility** → accessibility, highlight\_cta

### Batch Process Multiple URLs

```bash
python main.py --batch urls.txt --feature wireframe
```

(where `urls.txt` contains one URL per line)

### Re-Edit an Existing Screenshot

```bash
python main.py --input-image outputs/example_dark_mode.png --feature localization --language fr --re-edit
```

---

## Options

| Argument          | Description                                               | Default       |
| ----------------- | --------------------------------------------------------- | ------------- |
| `--url`           | Capture screenshot from a single website URL              | –             |
| `--batch`         | File containing multiple URLs (one per line)              | –             |
| `--input-image`   | Use an existing screenshot instead of capturing a new one | –             |
| `--re-edit`       | Reapply edits on an existing image                        | `False`       |
| `--output-dir`    | Directory to save results                                 | `outputs/`    |
| `--format`        | Output format (`png`, `jpg`, `webp`, `pdf`)               | `png`         |
| `--name-strategy` | Naming style (`url`, `timestamp`, `uuid`)                 | `url`         |
| `--save-original` | Save original screenshot before edits                     | `False`       |
| `--feature`       | Apply a single transformation feature                     | –             |
| `--preset`        | Apply a predefined set of features                        | –             |
| `--device`        | Device for mockups (`iPhone`, `MacBook`, etc.)            | `iPhone`      |
| `--language`      | Language code for localization (e.g., `es`, `fr`, `de`)   | `es`          |
| `--poster-title`  | Title for social preview images                           | `"Now Live!"` |
| `--poster-color`  | Brand color for recoloring UI elements                    | `#1D9BF0`     |

---

## Example Workflow

```bash
# Capture example.com → run dark mode + wireframe + CTA highlight
python main.py --url https://example.com --preset ux_review --output-dir results --format jpg --save-original
```

This will create:

* `results/example_com_original.jpg`
* `results/example_com_dark_mode.jpg`
* `results/example_com_wireframe.jpg`
* `results/example_com_highlight_cta.jpg`

---

## Roadmap

* [ ] Add batch parallelization
- [ ] Write unit tests
* [ ] Add custom prompt injection for advanced users
* [ ] Add more presets (SEO review, product showcase, accessibility audit)


