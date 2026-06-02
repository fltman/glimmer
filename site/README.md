# Glimmer — product site

A static marketing + documentation site for Glimmer. Plain **HTML, CSS and
JavaScript** — no build step, no framework.

```
site/
  index.html        # Overview / landing
  docs.html         # Extensive docs (sidebar + reference)
  faq.html          # FAQ
  assets/
    styles.css      # Design system (mirrors the app's tokens)
    app.js          # Mobile nav + docs scroll-spy
    glimmer-*.png   # Brand mark / logo / favicons
    screens/        # Optional: real PNG screenshots can go here
```

## Preview

```bash
cd site
python3 -m http.server 5190
# open http://localhost:5190
```

(Open via a server, not `file://`, so relative paths resolve.)

## Product visuals

The overview and docs use **real screenshots** of the app, captured from the
running editor and stored in `assets/screens/*.webp` (1600px, ~60–130 KB each).
To refresh them after a UI change: capture each screen, crop off the browser
chrome, drop the WebP into `assets/screens/`, and it's picked up by the existing
`<div class="frame"><img …></div>` in the HTML. (The `.mock*` classes in
`styles.css` are the original CSS UI mockups, kept as a fallback.)

## Keep it in sync

When Glimmer's functionality changes, update this site too — the overview, the
FAQ, and the docs (new tools, commands, shortcuts). It's meant to track the
product, not drift.

## Deploy

It's fully static — host the `site/` folder anywhere (GitHub Pages, Netlify,
Cloudflare Pages, an S3 bucket, …). For GitHub Pages from a subfolder, point
Pages at `/site` or copy its contents to the Pages branch root.
