# Graft Brand Kit v0.1

Three concepts, all pure SVG (infinitely scalable) + pre-rendered PNGs for every mobile/app/store size.

## Concepts
- **A — Graft Node (recommended primary):** two branches grafted onto one stem with a joint node — literally the product story: plugins grafted into one system. Friendly Grab-style green.
- **B — G Node:** bold geometric G monogram with a green graft-node, Zuora-style confident/enterprise feel. Good alt if A feels too playful.
- **C — Wordmark Sprout:** typography-first "graft" with a sprout accent — landing page hero / marketing use.

## Palette
| Token | Hex | Use |
|---|---|---|
| graft-green | #16A34A | primary |
| graft-green-deep | #15803D | gradients, hover |
| graft-green-light | #4ADE80 | accents, dark mode glyphs |
| graft-ink | #0F172A | wordmark, node on light bg |
| graft-indigo | #4F46E5 | concept B / enterprise accent |

Typeface: **Poppins Bold** (OFL license — free for commercial use). Wordmarks are converted to outlines: no font dependency anywhere.

## Files & when to use them
- `*/icon-app-gradient.svg` + `png/.../icon-app-gradient-{size}.png` — app icons, favicons, PWA
  - 16/32/48: favicon · 180: iOS apple-touch-icon · 192+512: Android/PWA manifest · 1024: App Store
- `A-graft-node/favicon-glyph.svg` — simplified thicker-stroke version tuned to stay readable at 16px
- `*/lockup-horizontal-*.svg` — navbar, email headers (use `-white` on dark backgrounds)
- `*/lockup-stacked-*.svg` — splash screens, mobile login, square social avatars
- `C-wordmark-sprout/*` — marketing site hero, OG images
- `*-mono-black / mono-white` — single-color contexts: print, embossing, loading states

## Rules
1. Clear space around the mark: ≥ height of the node dot ×2.
2. Never recolor outside the palette; never stretch; never add drop shadows.
3. On photos/busy backgrounds use mono-white or the app-gradient tile.
4. Minimum sizes: icon 16px, horizontal lockup 24px height.

## Next.js quick wiring
```
app/icon.svg          ← A-graft-node/favicon-glyph.svg
app/apple-icon.png    ← png/A-graft-node/icon-app-gradient-180x180.png
public/manifest icons ← 192 + 512 PNGs
```
