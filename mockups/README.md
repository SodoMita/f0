# FORM/0 — UI direction mockups

A static, front-end-only exploration of a more editorial, object-first FORM/0.
The production Babylon client is intentionally untouched.

## Pages

- [`index.html`](./index.html) — responsive world/gallery view
- [`viewer.html`](./viewer.html) — immersive single-creation viewer
- [`thread.html`](./thread.html) — branch map with zoom controls
- [`studio.html`](./studio.html) — creation studio and inspector
- [`generated.html`](./generated.html) — latest frameless Aero Wire concept, its style reference, and archived studies

## Direction

- Warm museum-catalogue surfaces instead of a uniformly black application
- A narrow ink navigation rail and one high-chroma signal per action
- Large object photography with restrained metadata and mono microcopy
- Shared interaction language across cards, viewer actions, branches, and tools
- Mobile bottom navigation, single-column gallery, and drawer-style viewer info
- No CDN, web fonts, or runtime image requests

The three artwork renders in `assets/` were generated specifically for this
mockup. The latest image-generation pass first created a dedicated Aero Wire
style reference, then supplied that reference alongside the primary page for a
second edit. The result is one uninterrupted vertical thread of different-sized,
frameless 3D models with minimal transparent controls (`generated/round-04/`).
Earlier framed studies remain archived for comparison. These boards are visual
research rather than literal production screens. `mockup.js` adds small
interactions to the HTML studies: gallery filters and density, viewer navigation,
thread zoom, studio tabs, live sliders, and a publish confirmation state.

Serve the repository root and open `/mockups/`. For example:

```bash
python3 -m http.server 4173 --bind 0.0.0.0
```
