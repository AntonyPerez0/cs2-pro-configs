# CS2 Pro Configs

Browse CS2 pro players' full settings and copy ready-to-paste console commands to apply any pro's crosshair (converted to the new CS2 crosshair system), sensitivity, viewmodel, HUD and radar.

**Live site:** https://copyprosta.com

## How to use

1. Open a player page from the list on the site.
2. Hit **Copy crosshair**, a single section, or the **full config**, which comes in
   2–3 parts.
3. In CS2, open the console (`~` or `` ` `` key), paste, press Enter. For the full
   config, paste and Enter each part in turn.

Or download the player's **.cfg**, save it in
`Counter-Strike Global Offensive/game/csgo/cfg/` and run `exec <name>` in the
console (for example `exec donk`). It holds the same converted commands, one per line.

Why parts: CS2 still ships the Source tokenizer, which rejects a console line
longer than 510 characters ("…overflows the tokenizer buffer.. Skipping!"), and
most pros' full configs are longer (up to about 1,200 characters). So the full
config is split by section (crosshair; mouse, viewmodel & radar; HUD & other).
Every copy button on the site is kept at 500 characters or less, and the build
fails if one isn't.

### The crosshair

CS2's Sept 22, 2026 "Rush Hour" update replaced the crosshair system. Sizes are now
pixels at the resolution they were authored at (`cl_crosshair_screen_height`), and
the game rescales them to yours. The gap is measured from the centre. Later updates
added half outlines (Sept 24) and outline colours and a new style (Oct 1). Old share
codes (`CSGO-…`) no longer import, and `cl_crosshairgap`, `cl_crosshaircolor`,
`cl_crosshairusealpha`, `cl_crosshair_outlinethickness`,
`cl_crosshairgap_useweaponvalue` and `cl_fixedcrosshairgap` were removed.

settings.gg still lists the pros' **pre-patch** settings, so the site converts each
one. It uses a pinned copy of the community converter
[small-indie-crosshair-company](https://github.com/sebastianspicker/small-indie-crosshair-company)
(v0.19.1, model `community-static-v11`, CS2 build 2000922, crosshair cvars unchanged
through 2000930), vendored under `scraper/vendor/`:

- **Resolution:** each pro is converted at their own resolution, and
  `cl_crosshair_screen_height` is set to it, so the crosshair keeps the pixels the
  pro saw and scales proportionally on yours.
- **Outline:** off, half or full, depending on the old outline thickness.
  Black outline colour.
- **Opacity:** an old config with the alpha slider off gets opacity 255.
- **Styles 2 and 5:** they keep their family, since Valve kept both numbers.
- **Warnings:** dot-only, crossed-arm, weapon-gap and unusual-colour cases get a
  note on the player page.
- **Already new format:** if settings.gg ever lists a crosshair in the new format,
  it is copied as-is.

Valve published no conversion formula, so this is a community reconstruction,
not checked against in-game captures. For some pros, converting their old
crosshair gives the one they published after the update (demo-derived codes,
Oct 2026): donk, KSCERATO, xiELO, YEKINDAR and w0nderful at length/thickness/gap
2/2/1, and FalleN at 3/2/0 with no outline. These are pinned in
`scraper/test_crosshair.mjs`. Not every pro matches. yuurih had the same old
settings as donk but published 2/2/0, and FL1T published 2/1/1 where the conversion
gives 2/1/2. Others (Jame, HObbit, zweih, molodoy) built a different crosshair
after the update. So a conversion of a pro's old crosshair may differ from what they
use now. Each player page says so and links their crosshair history.

Notes:

- **Mouse DPI / polling rate** are set in your mouse software, not the game. Make
  sure your driver matches the player's DPI shown on their page.
- **Video settings** (resolution, aspect ratio, stretched scaling) can't be applied via console. They're shown on each player page as manual tables, and the resolution can be forced with launch options.
- Convars that don't exist in CS2 or are cheat-protected (`cl_radar_size`, `cl_drawhud`, `cl_mouselook`, `setting.defaultres`, `setting.defaultresheight`, plus the removed crosshair convars) are filtered out automatically.
- Each page also shows the original settings.gg `autoexec.cfg` (pre-patch format,
  `cfg/raw/`). Don't exec it: its crosshair settings no longer work.

## Features

- Search and sort across 620 pro players
- **HLTV Top 10 section** on the front page (latest official HLTV player ranking, links straight to each pro's config)
- **Your-DPI sensitivity matcher**: enter your mouse DPI once, get the in-game sensitivity that matches each pro's speed (eDPI match), or copy the config part with the sensitivity rewritten for your DPI
- Crosshair converted to the current CS2 crosshair system, with a pixel preview (inline SVG, works without JavaScript)
- Per-category copy blocks (crosshair, sensitivity, viewmodel, radar, HUD, other)
- Launch options for forcing resolution
- Downloadable, converted per-player `.cfg` file
- Fully prerendered static pages (one per player at `/p/<slug>/`), sitemap and structured data for search engines
- Weekly auto-refresh of data via a GitHub Action

## Repo layout

```
.
├── index.html            # Player list page (generated)
├── p/<slug>/index.html   # One static page per player (generated)
├── player.html           # Redirect for old ?p=<slug> links (generated)
├── sitemap.xml, robots.txt, 404.html   # (generated)
├── assets/
│   ├── app.js            # Copy buttons, search/sort/filter, DPI matcher
│   ├── style.css         # Styles
│   └── og-default.png    # Social preview image
├── data/
│   ├── index.json        # Catalog of all players
│   ├── meta.json         # Dataset timestamp
│   ├── top10.json        # HLTV Top 10 list
│   ├── crosshair.json    # Converted crosshairs (generated by crosshair.mjs)
│   ├── players/<slug>.json  # Full per-player settings
│   └── avatars/<slug>.webp  # Player avatars
├── cfg/
│   ├── <slug>.cfg        # Converted config to exec (generated)
│   └── raw/<slug>.cfg    # settings.gg's original autoexec.cfg (pre-patch format)
└── scraper/
    ├── scrape.py         # Scraper for settings.gg -> data/, cfg/raw/
    ├── top10.py          # Best-effort HLTV Top 10 refresh
    ├── crosshair.mjs     # Converts every crosshair -> data/crosshair.json (Node 22)
    ├── vendor/small-indie-crosshair-company/  # Pinned converter (MIT), see VENDORED.md
    ├── sitegen.py        # Builds every HTML page, cfg file, sitemap and robots.txt
    ├── test_crosshair.mjs   # Conversion checks on fixed inputs
    ├── test_site.py      # Checks on the generated site (run in CI before each commit)
    └── requirements.txt  # Python dependencies
```

The HTML pages and `cfg/<slug>.cfg` are generated: edit `scraper/sitegen.py` (or
`assets/`), not the generated files, then rebuild.

## Updating the data

- The workflow runs **weekly** automatically (scheduled via GitHub Actions).
- To trigger a manual refresh, go to the **Actions** tab in this repo and click **Run workflow**.
- Or run it locally (Python 3.10+ and Node 22.12+):

```bash
pip install -r scraper/requirements.txt
node scraper/test_crosshair.mjs         # conversion checks
python3 scraper/scrape.py               # refresh data/ and cfg/raw/ from settings.gg
python3 scraper/top10.py                # optional, usually blocked by HLTV
node scraper/crosshair.mjs              # convert crosshairs -> data/crosshair.json
python3 scraper/sitegen.py              # rebuild the HTML pages, cfg files and sitemap
python3 scraper/test_site.py            # check the result
```

To preview the site locally, serve the repo root (the pages use root-relative
links): `python3 -m http.server` and open http://localhost:8000.

## Data source & credits

All settings data is sourced from [settings.gg](https://settings.gg) (community-generated pro configs). Crosshair conversion: [small-indie-crosshair-company](https://github.com/sebastianspicker/small-indie-crosshair-company) (MIT). This project is an unofficial, fan-made convenience tool and is **not** affiliated with settings.gg, Valve, or any player. Data is updated weekly.

## Disclaimer

This project is for personal use only. Settings accuracy depends on contributions to settings.gg.
