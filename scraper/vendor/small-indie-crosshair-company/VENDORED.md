# Vendored: Small Indie Crosshair Company

`lib/` is an unmodified copy of the `lib/` directory of
[sebastianspicker/small-indie-crosshair-company](https://github.com/sebastianspicker/small-indie-crosshair-company)
at commit `29a3c215de41a95eb3377eedf9eb156dbc55fcaa` (2026-10-08, package version 0.19.1,
default model `community-static-v11`, solver revision `visible-stroke-fit-2026-10-07`,
CS2 build 2000922; the crosshair cvars are unchanged through build 2000930).

It is MIT licensed (see `LICENSE`, `THIRD_PARTY_NOTICES.md` and `licenses/`). It has no
dependencies and does no I/O; `scraper/crosshair.mjs` calls it to convert each pro's
pre-patch crosshair into the current crosshair cvars.

To update: copy a newer `lib/` over this one, update the commit above and the
`REFERENCE` constant in `scraper/crosshair.mjs`, run `node scraper/crosshair.mjs` and
`python3 scraper/sitegen.py`, and review the diff of `data/crosshair.json`
(`scraper/test_crosshair.mjs` pins conversions that match pros' published
post-patch crosshairs).
