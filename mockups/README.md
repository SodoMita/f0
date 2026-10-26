# FORM/0 — UI direction mockups

A static, front-end-only exploration of a more editorial, object-first FORM/0.
The current HTML screens directly reconstruct the composition of the generated
concept boards: dashboard gallery, oversized numbered viewer, glowing lateral
branch map, and instrument-like studio. The production Babylon client is
intentionally untouched.

## Pages

- [`index.html`](./index.html) — responsive world/gallery view
- [`viewer.html`](./viewer.html) — immersive single-creation viewer
- [`thread.html`](./thread.html) — branch map with zoom controls
- [`studio.html`](./studio.html) — creation studio and inspector
- [`generated.html`](./generated.html) — wordless Aero Wire desktop/mobile concepts with icon-only navigation

## Direction

- Warm museum-catalogue surfaces instead of a uniformly black application
- A narrow ink navigation rail and one high-chroma signal per action
- Large object photography with restrained metadata and mono microcopy
- Shared interaction language across cards, viewer actions, branches, and tools
- Mobile bottom navigation, single-column gallery, and drawer-style viewer info
- No CDN, web fonts, or runtime image requests

The three artwork renders in `assets/` were generated specifically for this
mockup. The image-generation process first created a dedicated Aero Wire style
reference, then supplied it alongside every page edit. Round 04 established one
uninterrupted vertical thread of different-sized, frameless 3D models. Round 05
extended that system to every desktop and portrait view. Round 06 removes all
visible language from the application concepts: state, navigation, replies,
materials, transforms, and publishing are conveyed by consistent wire icons
only (`generated/round-06/`). The gallery itself is also visually wordless while
keeping non-visible ARIA labels and image alternatives for accessibility. These
boards are visual research rather than literal production screens.

Serve the repository root and open `/mockups/`. For example:

```bash
python3 -m http.server 4173 --bind 0.0.0.0
```
