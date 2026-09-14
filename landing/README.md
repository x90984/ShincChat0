# ShincChat — landing page

A production-ready, dependency-free marketing page for **ShincChat** (verified
random chat). Dark, glassy, gradient-lit, animated — and fully responsive,
accessible and mobile-first.

```
landing/
├── index.html        # full page: nav, hero, proof, features, showcase,
│                     # how-it-works, benefits, safety, testimonials,
│                     # pricing, FAQ, CTA, footer, instant-match demo modal
├── styles.css        # ~2.4k lines, mobile-first, tokenised design system
├── main.js           # all interactions (no libraries, no build step)
└── assets/
    ├── favicon.svg         # brand mark (gradient tile)
    ├── logo-mark.svg       # monochrome mark used inside the brand tile
    ├── og-cover.jpg        # 1200×630 social share image
    ├── panel-stranger.jpg  # hero + showcase video-call panel
    ├── panel-you.jpg       # hero + showcase video-call panel
    └── verify-blur.jpg     # blurred verification clip demo
```

## Run it

No build step, no dependencies. Either open `landing/index.html` directly, or
serve it (recommended — the fonts and relative paths behave best over HTTP):

```bash
node tools/preview-server.js          # http://localhost:3000  (zero deps)
# or
python3 -m http.server 3000 --directory landing
```

## Point the CTAs at the real app

Every call to action carries `data-app-link`. At the top of `main.js`:

```js
var APP_URL = '';                       // e.g. 'https://shincchat.com/chat'
```

* **Empty (default)** — CTAs open the on-page *instant match* preview modal so
  the page never dead-ends during demos or before the app is deployed.
* **Set** — the href of every CTA is rewritten to that URL on load and clicks
  navigate normally.

### Serving it from the existing Express app

`random-chat/server/index.js` already serves `public/` statically. Drop the
landing page in as the front door and move the app to `/chat`:

```js
const path = require('path');
const LANDING = path.join(__dirname, '..', '..', 'landing');   // adjust to your layout

app.use('/assets', express.static(path.join(LANDING, 'assets')));
app.get('/styles.css', (_req, res) => res.type('css').sendFile(path.join(LANDING, 'styles.css')));
app.get('/main.js',    (_req, res) => res.type('js').sendFile(path.join(LANDING, 'main.js')));
app.get('/',           (_req, res) => res.sendFile(path.join(LANDING, 'index.html')));
app.get('/chat',       (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
```

then set `APP_URL = '/chat'` in `main.js`. Any static host (Netlify, Vercel,
Cloudflare Pages, S3 + CloudFront, Render static site) works unchanged — and
putting it behind the same origin as the app keeps the HTTPS requirement that
camera/microphone access needs.

## What's on the page

| Section | Highlights |
| --- | --- |
| Sticky navbar | blur-on-scroll, gradient scroll-progress bar, active-section underline, live online counter, animated burger → full-screen sheet with staggered links, focus trap, `Esc` to close |
| Hero | staggered entrance, gradient headline, magnetic primary CTA, 3D-tilt product mock with a **live typing chat simulation** that loops two conversations, Text/Video preview toggle, floating glass stat cards with scroll parallax, ambient orbs, grain |
| Social proof | animated stat counters, dual-direction city & quote marquees (pause on hover) |
| Features | 7-card bento: match preferences (interactive chips + hint copy), **hover-to-reveal blurred verification demo**, mode pills, generated voice waveform, mini chat-history list, disappearing-message timers, friend chips, reporting reasons |
| Product showcase | accessible tablist (roving tabindex, arrow/Home/End keys) with auto-advance + progress bar that pauses on hover/focus/interaction; five hand-built mock screens: Text, Video, Voice, Verify (interactive reveal/skip), History |
| How it works | three numbered glass steps |
| Benefits | sticky two-column layout with six benefit blocks |
| Trust & safety | six-up safety grid inside a gradient glass panel |
| Testimonials | masonry column layout, 8 stories, star ratings, rating summary |
| Pricing | monthly/annual switch (`role="switch"`) with animated price flips, featured tier with animated gradient halo, per-tier feature lists including "not included" rows |
| FAQ | single-open accordion using the `grid-template-rows: 0fr → 1fr` technique, proper `aria-expanded` / `aria-controls` / regions, sticky "talk to a human" aside, `FAQPage` JSON-LD |
| Final CTA | orb-lit gradient panel, live online count, XL magnetic CTA |
| Footer | 4 link columns, newsletter with inline validation + toast, socials, 18+ notice, language selector, `WebApplication` JSON-LD |
| Extras | instant-match demo modal (searching radar → matched card → simulated replies, focus trap, `Esc`), back-to-top button, toast system, skip link, konami-ish easter egg |

## Accessibility

* Semantic landmarks, one `h1`, every section labelled with `aria-labelledby`.
* Skip link, visible `:focus-visible` rings, logical tab order.
* Decorative product mock-ups are `aria-hidden`, with an `sr-only` description
  of what the preview shows; the interactive demos (tabs, verification reveal,
  pricing switch, accordion, modal) are all keyboard-operable and labelled.
* `prefers-reduced-motion: reduce` disables reveals, marquees, orbs, tilt,
  magnetic buttons, parallax and smooth scrolling, and still shows all content.
* `forced-colors` and `print` fallbacks included.
* Body copy sits at ≥ 4.5:1 contrast against the dark canvas.

## Performance

* Zero JavaScript dependencies, zero build step, ~2.4k lines of CSS and
  ~840 lines of JS.
* Images are JPEG, resized and stripped (≈256 KB total); non-critical ones are
  `loading="lazy" decoding="async"` with explicit `width`/`height`.
* `backdrop-filter` is reduced and the grain overlay is dropped below 600 px.
* Animations use `transform`/`opacity`; scroll work is `requestAnimationFrame`
  throttled and the hero simulation pauses when it scrolls off-screen or the
  tab is hidden.

## Editing the copy

Everything is static HTML — search and replace:

* **Numbers** (`2.4M`, `190+`, `4.2s`, `4.8/5`, `32,418`, `12,483`) are
  placeholders. The counters read `data-count` / `data-decimals` in
  `index.html`; the live figure reads `data-online`.
* **Testimonials** are illustrative sample stories — swap in real, consented
  quotes before launch.
* **Pricing** lives in `.plan__price` (`data-monthly` / `data-annual`) and the
  `.plan__list` items; the annual discount label is in `setBilling()` in
  `main.js`.
* **Colours / radii / fonts** are tokens at the top of `styles.css`
  (`--teal`, `--indigo`, `--violet`, `--grad-brand`, `--r-lg`, …). The palette
  matches the app's `random-chat/public/index.html` variables.
* **Domain / social / mailto links** are placeholders (`#`, `hello@shincchat.com`).
