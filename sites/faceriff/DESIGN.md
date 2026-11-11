# FaceRiff design direction

FaceRiff is a meme video generator: each meme is a fixed template where visitors drop in faces. Meme #1 is the Tiny Desk "Outstanding" AI meme; more memes get their own pages later.

- **Audience**: people who just saw a meme on TikTok/Reels and want their own version in minutes, to post or drop in a group chat. Fast, playful, no editing skills.
- **Mood**: "late-night meme studio". Neon-lit, punchy, a bit cheeky. Footage is the hero; copy is short and conversational. Not a concert/NPR look, not a warm vintage look.
- **Fonts** (Google Fonts, one stylesheet, no self-hosted files): headings Bricolage Grotesque 800; short labels/tags Archivo Black, uppercase, never sentences; body Space Grotesk; numbers (price, seconds, seats) Space Mono.
- **Colors**: midnight navy `#0b1020`, panel `#151b33`; text `#eef0ff`, secondary `#c9cde8`, muted `#8f95b8`; primary hot coral `#ff4d6d` (buttons, emphasis, focus); lime `#c6f432` only for tiny accents (meme number tag, live dots); light content paper `#f3f1fb` with ink `#141634`. Dividers are text color at 12%.
- **Logo**: a coral smiling face with a lime music note (`public/logo.svg`), on navy.
- **Texture**: subtle grain on dark sections, coral glow top-right of the hero; clips muted, autoplay, loop, 14px radius.
- **Home first screen**: meme tag (`● MEME #1 · Tiny Desk`), H1 targeting "Tiny Desk AI meme", one-line lead, the seat-picker stage; on the right a 9:16 sample card with a Dogs / Original / FaceRiff cut switcher.
- **Disclaimer**: footer and FAQ always state FaceRiff is unofficial and not affiliated with NPR, Tiny Desk Concerts, Charlie Wilson or The Gap Band.
- **Avoid**: NPR/Tiny Desk branding in our identity; amber/cream "vintage stage" palette (that's the example site's look); purple gradients and glassmorphism.

## Components

- **Seat-picker stage**: three-frame collage (`public/media/stage*.jpg`) with dashed coral ring slots per performer (coordinates in `SEATS` in `tool.tsx`); live mono status line `swapped 2/5 · $9.88`; presets above, consent box and price below.
- **Shot strip**: four small vertical clips with timestamp, shot name and seat.
- **Generating / result**: three plain status steps with a time estimate (no fake percentages); two downloads (with song, muted).
- **Pricing**: three cards, featured one outlined in coral with an Archivo Black tag.
- **Content pages**: light paper cards, ink text, grotesque headings, mono tables.

## Adding the next meme

One meme = one landing route (`src/routes/<meme-slug>.tsx`), one model entry in `site.models.ts` with its R2 assets under `assets/<meme>/`, its media in `public/media/<meme>/`, and its own message keys. Home keeps Tiny Desk as meme #1 and links to the others.

## Owner dashboard

`/admin` is a standalone server-rendered, Simplified Chinese operations page. Reuse navy/panel/coral/lime, system fonts (no external requests), responsive KPI cards, horizontally scrollable numeric tables, and clear status badges. Read-only, no customer photos, prompts or full emails. Date windows and all timestamps use Asia/Shanghai. Daily traffic before collection begins must be unavailable, never invented zeros.
