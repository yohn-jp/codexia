# Codexia — optical icon system

The Codexia literary brand icon is an open, leather-bound manuscript with a rising writing quill. The [normative visual design](../../app/DESIGN.md) owns its intended appearance, accessibility and optical requirements; `codexia-icon.cjs` is the single dependency-free JavaScript/SVG rendering implementation, not a competing design specification.

## Build and test

    node scripts/branding/generate-icons.mjs
    node --test scripts/branding/codexia-icon.test.mjs

The script regenerates `app/public/favicon.svg` and the size-specific SVGs in `app/public/icons/`. All are checked into this branch; Vite copies them into the frontend without a CDN request.

## Pixel-grid and optical rules

- **16px**: preserve the manuscript silhouette and recognizable quill. The spine is a 1px stroke, important coordinates use intentional integer and half-pixel alignment. Details that would become noise are omitted.
- **24px**: a separately authored 24-unit master, not a 75% rendering of the 32px art.
- **32–40px**: dedicated compact master with strong paper/cover separation.
- **41–96px**: the standard master adds paper depth and a clearer feather shaft.
- **97px and above**: the premium master retains leather gilding, parchment curvature, ribbon and feather veins.
- Keep high-quality antialiasing for diagonal curves: pixel alignment is not equivalent to disabling smoothing.
- Preserve both the dark, light and single-color palettes. Never rely on the icon alone to communicate error/success states.

Open `preview.html` to inspect actual CSS pixel sizes and the nearest-neighbor enlarged 16/24/32px rasters. At display scales other than 100%, OS/browser resampling affects the perceived pixel grid.

The icon is decorative in browser chrome; do not replace accessible page titles or text labels with it. The meaningful standalone SVG includes a description; decorative inline SVG may use `accessible:false`.

**Current scope:** SVG branding source and website favicon. Native iOS PNG, multi-resolution ICO and Apple Icon Composer builds remain separate release integration tasks; do not claim those formats have been produced by this branch. Mobile Web/PWA is retired and has no manifest adoption task. Recognition and WCAG 2.2 AA conformance still require manual/assistive-technology acceptance.
