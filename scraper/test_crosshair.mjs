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
import { classicRecord, convertPlayer, CURRENT_CVARS } from './crosshair.mjs';

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
for (const slug of ['donk', 'kscerato', 'xielo', 'yekindar', 'w0nderful']) check(`${slug}: old 1/1/-4 family -> published 2/2/1`, geo(conv(rec(slug))), [2, 2, 1]);
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

check('converted entries say so', donk.kind, 'converted');
check('new-format entries are marked copied', already.kind, 'copied');
check('new-format default style (7, quad) gets no static-cross preview',
  conv({ slug: 'x', convars: { cl_crosshair_length: '3', cl_crosshair_thickness: '1', cl_crosshair_gap: '2' }, tables: {} }).preview, null);
check('new-format spread limit is kept', conv({ slug: 'x', convars: { cl_crosshairstyle: '7', cl_crosshair_length: '3',
  cl_crosshair_dynamic_spread_limit: '128' }, tables: {} }).cv.cl_crosshair_dynamic_spread_limit, '128');
check('a legacy config with spread_limit still converts', geo(conv(rec('donk', { cl_crosshair_dynamic_spread_limit: '255' }))), [2, 2, 1]);
const empty = convertPlayer({ slug: 'x', convars: { sensitivity: '1' }, tables: {} });
check('no crosshair settings -> blocked, not a crash', [empty.kind, empty.blockers?.length], ['blocked', 1]);

// ---- classic configs: settings CS:GO gained later are off, with the right reason ----
const classicP = (date, convars = {}, extra = {}) => ({ id: 'x', config: { date, ...extra,
  convars: { cl_crosshairsize: '2', cl_crosshairgap: '-1', cl_crosshairstyle: '4', ...convars } } });
const classic = (...a) => classicRecord(2013, classicP(...a));
const codes = (r) => r.notes.map((x) => x.code);
const pick = (r, ks) => ks.map((k) => r.convars[k]);
const c2012 = classic('2012-12-13');
check('2012: outline, T and recoil off', pick(c2012, ['cl_crosshair_drawoutline', 'cl_crosshair_t', 'cl_crosshair_recoil']), ['0', '0', '0']);
check('2012: they did not exist yet', codes(c2012), ['era-features-off']);
check('2012 style 4: the gap still changed per weapon', c2012.convars.cl_crosshairgap_useweaponvalue, '1');
check('...which the converter reports', convertPlayer(c2012).warnings.some((w) => w.code === 'weapon-gap-dropped'), true);
check('2014 style 4: weapon gap off (not added yet)', classic('2014-04').convars.cl_crosshairgap_useweaponvalue, '0');
check('2012 style 2 says CS2 style 2 is the accurate one', codes(classic('2012-12-13', { cl_crosshairstyle: '2' })).includes('era-style-2'), true);
check('2015 style 2 has no such note', codes(classic('2015', { cl_crosshairstyle: '2' })).includes('era-style-2'), false);
check('2013 (unknown day): outline existed by May, so off by default', codes(classic('2013')), ['era-features-off', 'era-default-off']);
const windowed = classic('2013', {}, { window: ['2013-01-13', '2013-04-25'] });
check('a known window narrows the era', [windowed.convars.cl_crosshairgap_useweaponvalue, codes(windowed)], ['1', ['era-features-off']]);
check('2022: off by default, recoil cheat-protected', codes(classic('2022-04-30', { cl_crosshair_drawoutline: '1' })),
  ['era-default-off', 'era-recoil-cheat']);
check('a set value is kept', classic('2022-04-30', { cl_crosshair_drawoutline: '1' }).convars.cl_crosshair_drawoutline, '1');
check('a CS2 config keeps the parser default for recoil', classic('2024-01-01').convars.cl_crosshair_recoil, undefined);
check('alpha outside 0-255 is clamped', classic('2014', { cl_crosshairalpha: '99999' }).convars.cl_crosshairalpha, '255');
check('the crosshair converts at its own source\'s resolution', classic('2014', {}, { video: { Resolution: '1024x768' },
  crosshair_resolution: '1280x1024' }).tables['Video Settings'].Resolution, '1280x1024');

if (fails.length) {
  console.log(`${fails.length} failure(s) of ${n} checks:`);
  for (const f of fails) console.log('  FAIL', f);
  process.exit(1);
}
console.log(`all ${n} checks passed`);
