# Component Styles Rules

When working with component-specific CSS in styles/components:

## Architecture
Each component that requires custom CSS has a corresponding file:
- `button.css` - Fire-inspired button shadows and effects
- `modal.css` - Modal animations and backdrop effects
- `spinner.css` - Custom loading animations

## Import Strategy
All component CSS files are imported in `styles/main.css`:
```css
/* Component styles */
@import "./components/button.css";
@import "./components/modal.css";
@import "./components/spinner.css";
```

## Guidelines
1. **Only create CSS files for components that need them** - If Tailwind utilities suffice, don't create a CSS file
2. **Use P3 colors with sRGB fallbacks** - Ensure wide gamut displays get enhanced colors
3. **Keep animations performant** - Use transform and opacity for animations
4. **Component classes should be prefixed** - e.g., `.button-primary`, `.modal-backdrop`

## P3 Color Example
```css
.button-primary {
  background: #fa5d19; /* sRGB fallback */
  background: color(display-p3 0.9816 0.3634 0.0984); /* P3 color */
}
```