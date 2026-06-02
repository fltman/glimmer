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

The feature/screen visuals are **faithful HTML/CSS mockups** built from the
app's real design tokens (see the `.mock*` classes in `styles.css`). They stay
crisp at any size and update in code — no re-screenshotting. To use real
screenshots instead, drop PNGs into `assets/screens/` and swap a `.mock`
block for `<figure class="shot"><div class="frame"><img src="assets/screens/…"></div></figure>`.

## Keep it in sync

When Glimmer's functionality changes, update this site too — the overview, the
FAQ, and the docs (new tools, commands, shortcuts). It's meant to track the
product, not drift.

## Deploy

It's fully static — host the `site/` folder anywhere (GitHub Pages, Netlify,
Cloudflare Pages, an S3 bucket, …). For GitHub Pages from a subfolder, point
Pages at `/site` or copy its contents to the Pages branch root.
