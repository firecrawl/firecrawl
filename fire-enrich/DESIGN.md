# Fire Enrich — Design system

> Extracted from `apps/web/colors.json`, `apps/web/tailwind.config.ts`, and `apps/web/styles/main.css`. The system already exists; this file documents what's there so polish work uses tokens instead of inventing values.

## Tailwind v3 quirks unique to this repo

Two things that bite if you don't know about them:

1. **The numeric size scale is in raw pixels.** `tailwind.config.ts` overrides `spacing`, `width`, `height`, `inset`, `borderRadius`, `borderWidth` with `Array.from({length:1000}).map(i => "${i}px")`. So `p-4` is **4 pixels**, not 16px. `w-56` is **56 pixels**, not 14rem. `gap-2` is **2 pixels**.
   - To get the conventional Tailwind 4px unit, multiply by 4: `p-16` for old `p-4`, `gap-8` for old `gap-2`, `w-256` for old `w-64`.
   - Or use arbitrary values: `p-[16px]`, `gap-[8px]`.
2. **The shadcn `bg-background` / `text-foreground` HSL CSS-vars in `main.css` are dead code.** The tailwind config maps `colors[key] -> var(--key)`, which would produce `color: 0 0% 100%` (invalid). Use the project palette tokens (`bg-background-base`, `text-accent-black`) instead.

## Color tokens (from `colors.json`)

All defined as `--key` CSS variables by `components/shared/color-styles/color-styles.tsx` and surfaced as Tailwind colors via `tailwind.config.ts`.

### Brand
- `heat-100` `#fa5d19` — Firecrawl orange. Primary CTA fill, active nav, brand mark.
- `heat-90` `#fa5d19e6` — primary CTA hover.
- `heat-40` / `heat-20` / `heat-16` / `heat-12` / `heat-8` / `heat-4` — orange wash for tinted backgrounds (banner, selected row, focus ring).

### Neutral surface
- `accent-black` — primary text.
- `accent-white` — surface on dark.
- `background-base` `#f9f9f9` — app background.
- `background-lighter` `#fbfbfb` — sidebar / panel background, slightly cooler than content.
- `border-faint` / `border-muted` / `border-loud` — divider strength scale.

### Black-alpha (overlays, hovers, dividers)
`black-alpha-1`, `-2`, `-3`, `-4`, `-5`, `-6`, `-7`, `-8`, `-10`, `-12`, `-16`, `-20`, `-24`, `-32`, `-40`, `-48`, `-56`, `-64`, `-72`, `-88` — used for hover states, muted icons, secondary text, subtle dividers.

### Status accents (semantic, not decorative)
- `accent-forest` — success / 200 OK.
- `accent-crimson` — error / 4xx, 5xx.
- `accent-honey` — warning / token missing, rate limit warning.
- `accent-bluetron` — info / running, in-flight.
- `accent-amethyst` — secondary / annotated metadata.

## Typography

`SuisseIntl` for UI, `Geist Mono` for code/data, `Roboto Mono` (the `font-ascii` family) for technical labels.

Named font sizes (use these, don't invent `text-13`):

| Token | Size / line-height | Use |
|---|---|---|
| `text-title-h1` | 60/64 | Hero only (rarely in product). |
| `text-title-h2` | 52/56 | Section landmark. |
| `text-title-h3` | 40/44 | Page title (heavy pages). |
| `text-title-h4` | 32/36 | Page title (standard). |
| `text-title-h5` | 24/28 | Subsection. |
| `text-title-blog` | 24/32 | Body-leading prose. |
| `text-body-x-large` | 20/28 | Lead paragraph. |
| `text-body-large` | 18/28 | Body. |
| `text-body-medium` | 16/24 | Default body. |
| `text-body-small` | 14/20 | Form labels, dense lists. |
| `text-body-input` | 14/20 | Inputs. |
| `text-label-x-large` | 18/20 | Button (large). |
| `text-label-large` | 16/20 | Button. |
| `text-label-medium` | 14/16 | Button (small). |
| `text-label-small` | 12/16 | Tag, badge. |
| `text-label-x-small` | 11/12 | Eyebrow, caption. |
| `text-mono-medium` | 14/20 mono | Code line. |
| `text-mono-small` | 12/16 mono | Token, ID, header. |
| `text-mono-x-small` | 11/16 mono | Tiny technical caption. |

Avoid `text-xs/sm/base/lg/xl/2xl/...` — they exist (defaults) but mix poorly with the named scale.

## Spacing & sizing — practical translation

For people writing CSS today:

| Want | Class |
|---|---|
| 4px | `p-4` / `gap-4` / `m-4` |
| 8px | `p-8` / `gap-8` |
| 12px | `p-12` |
| 16px | `p-16` |
| 24px | `p-24` |
| Sidebar 256px | `w-256` |
| Header bar 56px | `h-56` |
| Icon 16px | `h-16 w-16` (or just keep using `h-4 w-4` knowing it's 4px — almost always wrong) |

When in doubt, arbitrary values (`p-[14px]`) are fine and clearer than hunting the scale.

Border radius: `rounded-4`, `rounded-6`, `rounded-8`, `rounded-10`, `rounded-12`. `rounded-full` for pills.

## Components

shadcn-style primitives live in `apps/web/components/ui/`. The `sidebar.tsx` shipped here is **Tailwind v4 syntax** and silently fails on this v3 project — do not use it directly. Build the sidebar with plain `<aside>` + project tokens (the `AppSidebar` does this).

Other primitives (`button`, `input`, `dialog`, `tabs`, `tooltip`) are wired up.

## Motion

- Default duration: 200ms (`tailwind.config.ts` sets `transitionDuration.DEFAULT = "200ms"`).
- Default easing: `cubic-bezier(0.25, 0.1, 0.25, 1)` (a balanced ease, registered as Tailwind default).
- Avoid CSS layout-property animation (no animating `width`/`height`/`padding`).
- No bounce, no elastic, no orchestrated entrance sequences.

## Status & state language

Always pair semantic color with a glyph or short label so it survives color-blindness:

- `accent-forest` + `CircleCheck` icon — success.
- `accent-crimson` + `CircleAlert` — error.
- `accent-honey` + `TriangleAlert` — warning.
- `accent-bluetron` + spinner / `Loader2` — running.

## Anti-patterns specific to this UI

- `border-l-4 border-heat-100` "side stripe" callouts — banned per impeccable global.
- Gradient text on the brand orange — banned.
- Cards-inside-cards for response panels. Use a single panel with sectioned content.
- Putting `text-accent-black/40` muted gray text on `bg-heat-12` orange wash — use `text-heat-100/80` instead, per "gray on color" rule.
