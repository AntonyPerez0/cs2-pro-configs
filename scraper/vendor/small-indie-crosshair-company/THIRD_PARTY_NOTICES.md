# Third-party notices

Original project code and original explanatory documents are MIT licensed.
That does not transfer ownership of other parties' trademarks, game code, source
repositories, provider pages, player names, or screenshots users import.

## AkiVer csgo-sharecode

The legacy share-code codec in `lib/settings/sharecode.js` and the inherited Python archive
are based on the documented format and implementation from AkiVer's
[csgo-sharecode](https://github.com/akiver/csgo-sharecode/tree/753f16fe97f9bbb121fb56675b40f035ad403d05),
Copyright (c) 2017-present AkiVer, under the MIT License. The complete required
notice is retained in `licenses/akiver-MIT.txt`, and the original supplied notice
remains at `research/archive/2026-09-23/LICENSE_csgo-sharecode.txt`.

## patriQ cursed-crosshair-generator

The read-only `CS…` share-code decoder in `lib/settings/sharecode-cs.js` is an
independent implementation of the byte layout described in patriQ's
[cursed-crosshair-generator](https://github.com/patriqcs/cursed-crosshair-generator/tree/fa88525f6dc6f0c2cd3474194b292d1be3730c1e)
(`public/js/sharecode.js`), Copyright (c) 2026 patriQ, under the MIT License. The
complete notice is retained in `licenses/cursed-crosshair-generator-MIT.txt`. The
decoder's test vectors were cross-checked against that decoder and against
SpiRaL-network/cs2-crosshair-lab, whose code is not used.

## Research references, not bundled engines

The old geometry is an independently implemented mathematical reconstruction
following the documented CS2KZ model, cited in the [source ledger](docs/research/source-ledger.md).
This repository does not distribute Valve's client binaries, a decompiled native
renderer, a game asset collection, or the CS2KZ plugin. Historical generator
calculations are small, attributed numerical comparator models, not copies of
those applications. Their source repositories remain separately licensed.

The dated pro settings and their provenance are a small factual research dataset
transcribed from the supplied archive. Original provider pages, descriptions,
photos, logos, and demos are not bundled. Player labels identify the archived
observations, not endorsement or verified current personal settings.

## Brand and assets

“Small Indie Crosshair Company” is an independent parody project name. Valve,
Counter-Strike, CS2 and Volvo are not project sponsors or affiliates. No Valve
or Volvo logos, proprietary game backgrounds or player portraits are distributed.
The crosshair mark and interface are code-native.

## Typefaces

Two variable fonts are self-hosted in `public/fonts/`, subset to Latin, under the
SIL Open Font License 1.1:

- **Archivo**, Copyright 2020 The Archivo Project Authors
  (https://github.com/Omnibus-Type/Archivo). License: `licenses/Archivo-OFL.txt`.
- **Martian Mono**, Copyright 2021 The Martian Mono Project Authors
  (https://github.com/evilmartians/mono). License: `licenses/MartianMono-OFL.txt`.

The files are the unmodified Latin subsets served by Google Fonts.

## Expanded pro-code corpus (v0.2.0)

The new corpus transcribes factual player-name/share-code/identifier associations
from a pinned ProCrosshairs-derived archive and a published ProCrosshairs index,
with original xhair.pro fixtures retained. Exact source URLs and the original Git
blob checksum are in `docs/research/quant-sources.md`. Unknown match dates and
resolutions remain unknown. The source repository's program code and artwork are
not copied. This project's MIT license does not purport to relicense third-party
marks, factual source collections, or proprietary game assets.

## Optional mathematical authoring tool

MathJax's TeX input parser was used as an optional authoring tool to serialize our
own equations to native MathML. The deployment contains that generated markup,
not MathJax program code, font files or a runtime MathJax dependency. The normal
build uses the checked-in content-addressed equation cache.
