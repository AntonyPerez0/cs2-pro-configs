#!/usr/bin/env node
/*
 * Crosshair conversion checks on fixed inputs (scraper/test_crosshair_fixtures.json:
 * real pros' pre-patch settings), so they don't depend on the weekly scrape.
 *
 * The anchors are pros whose post-patch crosshair is known from demo-derived
 * share codes (xhair.pro / procrosshairs, Oct 2026). The other checks pin rules
 * established from CS2's current convar dump and patch notes. Exit 1 on failure.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertPlayer, CURRENT_CVARS } from './crosshair.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(HERE, 'test_crosshair_fixtures.json'), 'utf8'));
const fails = [];
let n = 0;
const check = (name, got, want) => {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};
const rec = (slug, over = {}) => ({
  slug,
  convars: { ...FIX[slug].convars, ...over },
  tables: FIX[slug].resolution ? { 'Video Settings': { Resolution: FIX[slug].resolution } } : {},
});
const conv = (r) => {
  const out = convertPlayer(r);
  return { ...out, cv: Object.fromEntries((out.commands ?? []).map((c) => c.split(' '))) };
};
const geo = (o) => [o.cv.cl_crosshair_length, o.cv.cl_crosshair_thickness, o.cv.cl_crosshair_gap].map(Number);

// ---- anchors: published post-patch crosshairs ----
for (const slug of ['donk', 'kscerato', 'yekindar', 'w0nderful']) check(`${slug}: old 1/1/-4 family -> published 2/2/1`, geo(conv(rec(slug))), [2, 2, 1]);
const donk = conv(rec('donk'));
check('donk authored at his 960p', [donk.height, donk.cv.cl_crosshair_screen_height], [960, '960']);
check('donk: alpha slider off -> opacity 255 (published)', donk.cv.cl_crosshaircolor_a, '255');
const fallen = conv(rec('fallen'));
check('fallen: crossed arms -> published 3/2/0', geo(fallen), [3, 2, 0]);
check('fallen: outline width 0 -> off (published)', fallen.cv.cl_crosshair_drawoutline, '0');

// ---- rules ----
check('outline width 0.5 -> half outline', conv(rec('aidkit')).cv.cl_crosshair_drawoutline, '2');
const awzek = conv(rec('awzek'));
check('full outline sets the outline colour (black, old additive 200)',
  ['r', 'g', 'b', 'a'].map((c) => awzek.cv[`cl_crosshairoutline_${c}`]), ['0', '0', '0', '200']);
check('no outline -> no outline colour', 'cl_crosshairoutline_a' in donk.cv, false);
check('old style 5 keeps its family', conv(rec('fino')).cv.cl_crosshairstyle, '5');
const hades = conv(rec('hades'));
check('old style 2 keeps its family', hades.cv.cl_crosshairstyle, '2');
check('style 2 keeps its split-pip cvars', hades.cv.cl_crosshair_dynamic_splitdist !== undefined, true);
check('split-pip cvars only for style 2', Object.keys(donk.cv).filter((k) => k.startsWith('cl_crosshair_dynamic_')), []);
check('weapon gap warns', hades.warnings.some((w) => w.code === 'weapon-gap-dropped'), true);
const nivera = conv(rec('nivera'));
check('colour index 7 keeps its stored RGB and warns',
  [nivera.cv.cl_crosshaircolor_r, nivera.cv.cl_crosshaircolor_g, nivera.cv.cl_crosshaircolor_b, nivera.warnings.some((w) => w.code === 'color-index-unknown')],
  ['0', '255', '0', true]);
const jame = conv(rec('jame'));
check('size-0 dot design drawn with short arms, dot on', [Number(jame.cv.cl_crosshair_length) > 0, jame.cv.cl_crosshairdot], [true, '1']);
check('no invented dot', conv(rec('perx')).cv.cl_crosshairdot, '0');
check('injection in a style-2 split value is dropped',
  conv(rec('hades', { cl_crosshair_dynamic_splitdist: '7; quit' })).cv.cl_crosshair_dynamic_splitdist, undefined);
check('only current cvars', [...new Set(Object.keys(FIX).filter((k) => k !== '_about')
  .flatMap((s) => convertPlayer(rec(s)).commands.map((c) => c.split(' ')[0])))].filter((k) => !CURRENT_CVARS.includes(k)), []);
check('screen height is the last command', donk.commands.at(-1), 'cl_crosshair_screen_height 960');
const noRes = conv({ slug: 'x', convars: FIX.donk.convars, tables: {} });
check('unknown resolution -> authored at 1080', [noRes.height, noRes.heightSource], [1080, 'default']);
check('preview: donk is four 2x2 arms around a 2px hole',
  donk.preview.fill.map(([x, y, w, h]) => [w, h]), [[2, 2], [2, 2], [2, 2], [2, 2]]);

// ---- a crosshair already in the new format is copied, not converted ----
const already = conv({ slug: 'x', convars: { cl_crosshairstyle: '4', cl_crosshair_length: '3', cl_crosshair_thickness: '1', cl_crosshair_gap: '2',
  cl_crosshairdot: 'false', cl_crosshair_drawoutline: '1', cl_crosshaircolor_a: '255', cl_crosshair_screen_height: '1440',
  cl_crosshairgap: '-2', cl_crosshaircolor_r: '0; quit' }, tables: { 'Video Settings': { Resolution: '1280x960' } } });
check('new format copied as-is', geo(already), [3, 1, 2]);
check('new format keeps its authored height', already.cv.cl_crosshair_screen_height, '1440');
check('new format drops legacy and unsafe values', ['cl_crosshairgap' in already.cv, 'cl_crosshaircolor_r' in already.cv], [false, false]);
check('new format normalizes booleans', already.cv.cl_crosshairdot, '0');

if (fails.length) {
  console.log(`${fails.length} failure(s) of ${n} checks:`);
  for (const f of fails) console.log('  FAIL', f);
  process.exit(1);
}
console.log(`all ${n} checks passed`);
