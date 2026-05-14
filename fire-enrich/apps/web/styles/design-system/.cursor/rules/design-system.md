# Firecrawl Design System Rules

When working with the fire-inspired design system:

## Important Note
- For existing pages: Continue using `styles/main.css`
- For Dashboard v2 pages: Import `styles/dashboard.css` in the layout

## Color System
Use CSS custom properties with P3 color space for richer colors:
- **Heat colors**: `--heat-4` through `--heat-100` (fire orange shades)
- **Accent colors**: `--accent-black`, `--accent-amethyst`, `--accent-bluetron`, `--accent-crimson`
- **Alpha variants**: Black and white with various opacity levels
- **UI colors**: Borders, backgrounds, illustrations
- All colors have sRGB fallbacks for browser compatibility

## Typography
**Font Families:**
- Display: SuisseIntl (weights: 400, 450, 500, 600, 700)
- Mono: System monospace stack (SF Mono, Monaco, Inconsolata, etc.)

**Type Scale Classes:**
- Headings: `.title-h1` through `.title-h5`
- Body: `.body-small`, `.body-medium`, `.body-large`, `.body-x-large`
- Labels: `.label-small`, `.label-medium`, `.label-large`, `.label-x-large`
- Mono: `.mono-small`, `.mono-medium`, `.mono-large`

## Utilities
**Gradients:**
- `.gradient-fire` - Heat gradient
- `.gradient-heat` - Subtle heat gradient
- `.gradient-sunset` - Heat to amethyst
- `.gradient-ocean` - Blue gradient

**Layout:**
- `.container-prose` - Max 65ch width
- `.center-absolute` - Absolute centering
- `.stack-*` - Vertical spacing
- `.layout-sidebar` - Sidebar layout pattern

**Effects:**
- `.blur-backdrop` - Backdrop blur
- `.border-gradient` - Gradient border
- `.mask-fade-*` - Fade masks
- `.focus-ring` - Accessible focus states
- `.dotted-underline` - SVG dotted underline

## Animation Classes
- `.cursor` - Blinking cursor
- `.animate-spin-reverse` - Reverse rotation
- `.animate-flicker` - Fire flicker effect
- `.animate-glow` - Glowing effect
- `.transition-*` - Smooth transitions

## Usage Example
```css
.fire-button {
  background: var(--heat-100);
  color: var(--white);
  padding: 0.75rem 1.5rem;
  border-radius: 0.5rem;
  transition: all 0.3s ease;
}

.fire-button:hover {
  background: var(--accent-crimson);
  box-shadow: 0 0 40px rgba(250, 93, 25, 0.8);
}
```

## Component CSS Architecture
Component-specific styles go in `styles/components/`:
- Button.css - Fire-inspired button styles
- Input.css - Input with heat focus states
- Modal.css - Modal with fire animations

## Build Optimization
- PostCSS handles optimization
- Tailwind v3 purging via content paths in tailwind.config.js
- P3 color space with automatic sRGB fallbacks
- Font preloading for performance