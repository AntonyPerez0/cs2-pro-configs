# CS2 Pro Configs

Browse CS2 pro players' full settings and copy ready-to-paste console commands to instantly apply any pro's crosshair, sensitivity, viewmodel, HUD/radar.

**Live site:** https://antonyperez0.github.io/cs2-pro-configs/

## How to use

1. Open a player page from the list on the site.
2. Hit **Copy full config** to copy the entire ready-to-paste config.
3. In CS2, open the console (`~` or `` ` `` key), paste, press Enter. Done!

The config is a **single `;`-separated line** on purpose: the CS2 console is a
single-line input, so multi-line pastes are unreliable. All commands are joined
with `;` so one paste applies everything at once.

Crosshair: CS2's Sept 22, 2026 "Rush Hour" patch replaced the crosshair system.
Legacy share codes (`CSGO-…`) no longer import, and the old `cl_crosshair*`
convars (`cl_crosshairgap`, `cl_crosshaircolor`, `cl_crosshairusealpha`,
`cl_crosshair_outlinethickness`, `cl_crosshairgap_useweaponvalue`,
`cl_fixedcrosshairgap`) were removed. The site converts every player's original
crosshair into the new convars (`cl_crosshair_length`, `cl_crosshair_thickness`,
`cl_crosshair_gap`, `cl_crosshaircolor_a`, `cl_crosshair_screen_height`, …)
before pasting, using the community reference converter's validated model —
for donk/m0NESY/s1mple it reproduces the published post-patch values
(length 2 / thickness 2 / gap 0) exactly.

Notes:

- **Mouse DPI / polling rate** are set in your mouse software, not the game — make sure your driver matches the player's DPI shown on their page.
- **Video settings** (resolution, aspect ratio, stretched scaling) can't be applied via console. They're shown on each player page as manual tables, and the resolution can be forced with launch options.
- Convars that don't exist in CS2 or are cheat-protected (`cl_radar_size`, `cl_drawhud`, `setting.defaultres`, `setting.defaultresheight`) are filtered out of the copy-paste blocks automatically.
- Alternative: save the config as `autoexec.cfg` in `Counter-Strike Global Offensive/game/csgo/cfg` and run `exec autoexec` in the console.

## Features

- Search and sort across 620 pro players
- Per-category copy blocks (crosshair, sensitivity, viewmodel, HUD/radar)
- Live crosshair preview rendered on a canvas
- Launch options for forcing resolution
- Downloadable per-player `.cfg` file
- Crosshair share code per player
- Weekly auto-refresh of data via a GitHub Action

## Repo layout

```
.
├── index.html            # Player list page
├── player.html           # Per-player detail page
├── assets/
│   ├── app.js            # Site logic (fetches data, renders, copy buttons)
│   └── style.css         # Styles
├── data/
│   ├── index.json        # Catalog of all players
│   └── players/<slug>.json  # Full per-player settings
├── avatars/ (data/avatars/)
│   └── <slug>.png        # Player avatars
├── cfg/
│   └── <slug>.cfg        # Downloadable autoexec-style config per player
└── scraper/
    ├── scrape.py         # Scraper for settings.gg
    └── requirements.txt  # Python dependencies
```

## Updating the data

- The workflow runs **weekly** automatically (scheduled via GitHub Actions).
- To trigger a manual refresh, go to the **Actions** tab in this repo and click **Run workflow**.
- Or run it locally:

```bash
pip install -r scraper/requirements.txt && python3 scraper/scrape.py
```

## Data source & credits

All settings data is sourced from [settings.gg](https://settings.gg) (community-generated pro configs). This project is an unofficial, fan-made convenience tool and is **not** affiliated with settings.gg, Valve, or any player. Data is updated weekly.

## Disclaimer

This project is for personal use only. Settings accuracy depends on contributions to settings.gg.
