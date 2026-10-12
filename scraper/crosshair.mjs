#!/usr/bin/env node
/*
 * Convert every pro's pre-patch crosshair (data/players/<slug>.json, legacy
 * cl_crosshair* convars from settings.gg) into the crosshair cvars CS2 has
 * used since the Sept 22, 2026 "Rush Hour" update, with the vendored
 * community reference converter (scraper/vendor/small-indie-crosshair-company).
 *
 * Also converts the classic configs in data/classic.json (top 10 pros of
 * 2011-2015, CS:GO-era settings).
 *
 * Writes data/crosshair.json, which sitegen.py reads. Run after scrape.py:
 *   node scraper/crosshair.mjs           write data/crosshair.json
 *   node scraper/crosshair.mjs --check   exit 1 if the file is out of date
 *
 * Each pro is converted at their own vertical resolution (old = current =
 * authored height) and cl_crosshair_screen_height is set to it: the old game
 * scaled size and thickness with the resolution, and the new game scales the
 * pixel values from the height they were authored at. Old styles 2 and 5 keep
 * their family (Valve kept both numbers and families in the new style list).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const LIB = join(HERE, 'vendor', 'small-indie-crosshair-company', 'lib');
const lib = (p) => import(join(LIB, p));

const { parseLegacyTextWithNotes } = await lib('settings/import.js');
const { infer } = await lib('solver/inference.js');
const { exportQuantCFG, mergedExportOverrides } = await lib('solver/export.js');
const { defaultExportGroups, nativeOutlineExtent } = await lib('settings/native.js');
const { defaultsWarning } = await lib('settings/outcomes.js');
const { COMMUNITY_MODEL, COMMUNITY_REVISION } = await lib('geometry/community.js');
const { forward } = await lib('solver/renderer.js');
const { rectangles, outlineRectangles } = await lib('geometry/raster.js');

export const REFERENCE = {
  name: 'small-indie-crosshair-company',
  url: 'https://github.com/sebastianspicker/small-indie-crosshair-company',
  commit: '29a3c215de41a95eb3377eedf9eb156dbc55fcaa',
  version: '0.19.1',
  model: COMMUNITY_MODEL.version,
  revision: COMMUNITY_REVISION,
  build: COMMUNITY_MODEL.build,
};

// true for every conversion; the site states them once instead of per player
const GENERIC = new Set(['community-reconstruction', 'shape-loss-excludes-appearance']);
const NUMBER = /^-?\d+(\.\d+)?$/;

// the current game's crosshair cvars (build 2000922, unchanged through 2000930), in export order
export const CURRENT_CVARS = [
  'cl_crosshairstyle', 'cl_crosshair_length', 'cl_crosshair_thickness', 'cl_crosshair_gap',
  'cl_crosshairdot', 'cl_crosshair_t', 'cl_crosshair_drawoutline',
  'cl_crosshairoutline_r', 'cl_crosshairoutline_g', 'cl_crosshairoutline_b', 'cl_crosshairoutline_a',
  'cl_crosshair_recoil', 'cl_crosshaircolor_r', 'cl_crosshaircolor_g', 'cl_crosshaircolor_b', 'cl_crosshaircolor_a',
  'cl_crosshair_dynamic_splitdist', 'cl_crosshair_dynamic_splitalpha_innermod',
  'cl_crosshair_dynamic_splitalpha_outermod', 'cl_crosshair_dynamic_maxdist_splitratio',
  'cl_crosshair_dynamic_spread_limit', 'cl_crosshair_sniper_width', 'cl_crosshair_screen_height',
];
// present only in configs saved after the Sept 22, 2026 update
const NEW_ONLY = ['cl_crosshair_length', 'cl_crosshair_thickness', 'cl_crosshair_gap', 'cl_crosshair_screen_height',
  'cl_crosshaircolor_a', 'cl_crosshairoutline_r', 'cl_crosshairoutline_g', 'cl_crosshairoutline_b', 'cl_crosshairoutline_a'];

const numeric = (v) => {
  const s = String(v).trim().toLowerCase();
  return s === 'true' ? '1' : s === 'false' ? '0' : NUMBER.test(s) ? s : null;
};

/** Vertical resolution the pro played at, from settings.gg's video table. */
export function playerHeight(rec) {
  const res = rec.tables?.['Video Settings']?.Resolution ?? '';
  const m = /^\s*\d+\s*[x×]\s*(\d+)\s*$/.exec(res);
  const h = m ? Number(m[1]) : 0;
  return h >= 240 ? { height: h, source: 'resolution' } : { height: 1080, source: 'default' };
}

const cells = (r) => [r.x, r.y, r.w, r.h];

// the converter's texts address someone pasting into its app; reword them for a page
const pageText = (t) => String(t)
  .replace(/ Add cl_crosshairstyle 4 to the paste[^.]*\./, '')
  .replace('Not in the paste, game defaults used: ', 'Not in this config, so the pre-update game defaults are used: ')
  .replace("Added from the old game's defaults because your paste did not set them: ",
    'Not in this config, so the pre-update game defaults are used: ');

function previewOf(native, height, flags, outlineMode, value) {
  try {
    const geometry = forward({ ...native, authoredHeight: height }, height, COMMUNITY_MODEL);
    const outlineOn = outlineMode > 0;
    return {
      fill: rectangles(geometry, flags).map(cells),
      outline: outlineOn ? outlineRectangles(geometry, flags, [{ low: 0, high: 0 }, { low: 1, high: 1 }, { low: 1, high: 0 }][outlineMode]).map(cells) : [],
      rgba: ['r', 'g', 'b', 'a'].map((c) => Number(value(`cl_crosshaircolor_${c}`) ?? 255)),
      outlineRgba: outlineOn ? ['r', 'g', 'b', 'a'].map((c) => Number(value(`cl_crosshairoutline_${c}`) ?? (c === 'a' ? 255 : 0))) : null,
    };
  } catch {
    return null; // e.g. a negative style-2 gap, which the static preview can't draw
  }
}

/** A crosshair settings.gg already lists in the new format: copied as-is (current cvars only). */
function passThrough(rec, height, source) {
  const cv = rec.convars ?? {};
  const commands = [];
  for (const name of CURRENT_CVARS) {
    if (name === 'cl_crosshair_screen_height') continue;
    const v = cv[name] === undefined ? null : numeric(cv[name]);
    if (v !== null) commands.push(`${name} ${v}`);
  }
  const authored = numeric(cv.cl_crosshair_screen_height ?? '');
  const h = authored !== null && Number(authored) >= 240 ? Math.round(Number(authored)) : height;
  commands.push(`cl_crosshair_screen_height ${h}`);
  const value = (name) => commands.find((c) => c.startsWith(`${name} `))?.split(' ')[1];
  const int = (name, d) => Math.round(Number(value(name) ?? d));
  const native = { length: int('cl_crosshair_length', 8), thickness: int('cl_crosshair_thickness', 2), gap: int('cl_crosshair_gap', 4) };
  const flags = { dot: value('cl_crosshairdot') === '1', t_style: value('cl_crosshair_t') === '1' };
  return {
    kind: 'copied',
    height: h,
    heightSource: authored !== null ? 'config' : source,
    commands,
    native,
    shape: null,
    warnings: [{ code: 'already-new-format', text: 'settings.gg already lists this crosshair in the format CS2 uses since the Sept 22, 2026 update, so it is copied as-is instead of converted.' }],
    // the static-cross model only draws styles 2/4/5 (circle, dot-only, square and quad styles differ);
    // a missing style is the game default 7
    preview: [2, 4, 5].includes(int('cl_crosshairstyle', 7)) ? previewOf(native, h, flags, int('cl_crosshair_drawoutline', 0), value) : null,
  };
}

export function convertPlayer(rec) {
  const { height, source } = playerHeight(rec);
  if (NEW_ONLY.some((k) => rec.convars?.[k] !== undefined)) return passThrough(rec, height, source);
  // numbers and booleans only: anything else (e.g. a value with ';') is dropped
  // here rather than letting it reject the whole crosshair. spread_limit is a
  // post-update cvar the legacy parser refuses; it does nothing for a static cross
  const legacy = Object.entries(rec.convars ?? {}).filter(([k, v]) =>
    k.startsWith('cl_crosshair') && k !== 'cl_crosshair_dynamic_spread_limit' && numeric(v) !== null);
  if (!legacy.length) return { kind: 'blocked', height, heightSource: source, blockers: ['No crosshair settings are listed for this player.'] };
  const parsed = parseLegacyTextWithNotes(legacy.map(([k, v]) => `${k} ${v}`).join('\n'));
  const options = { oldHeight: height, currentHeight: height, authoredHeight: height, styleTarget: 'family' };
  const report = infer({ settings: parsed.config, options, selectedModelId: COMMUNITY_MODEL.id });
  if (report.blockers.length) return { kind: 'blocked', height, heightSource: source, blockers: report.blockers.map(pageText) };

  const overrides = mergedExportOverrides(report);
  const commands = exportQuantCFG(report, defaultExportGroups(parsed.assigned, report.settings, overrides)).split(';');
  const value = (name) => commands.find((c) => c.startsWith(`${name} `))?.split(' ')[1];
  const style = Number(value('cl_crosshairstyle'));

  // the split-pip cvars only affect style 2 (the converter itself doesn't emit them)
  if (style === 2) {
    const at = commands.findIndex((c) => c.startsWith('cl_crosshair_screen_height '));
    const dyn = legacy.filter(([k, v]) => k.startsWith('cl_crosshair_dynamic_') && NUMBER.test(String(v).trim()))
      .map(([k, v]) => `${k} ${String(v).trim()}`);
    commands.splice(at, 0, ...dyn);
  }

  const settings = report.settings, native = report.chosen.native;
  const flags = { dot: Boolean(settings.dot), t_style: overrides.t_style ?? Boolean(settings.t_style) };
  const geometry = forward(native, height, COMMUNITY_MODEL);
  const filled = defaultsWarning(parsed.notes);
  const outlineOn = Number(value('cl_crosshair_drawoutline')) > 0;
  return {
    kind: 'converted',
    height,
    heightSource: source,
    commands,
    native: { length: native.length, thickness: native.thickness, gap: native.gap },
    shape: report.shapeCheck?.status ?? null,
    warnings: [...(filled ? [filled] : []), ...report.warnings]
      .filter((w) => !GENERIC.has(w.code)).map((w) => ({ code: w.code, text: pageText(w.text ?? w.message) })),
    preview: {
      fill: rectangles(geometry, flags).map(cells),
      outline: outlineOn ? outlineRectangles(geometry, flags, nativeOutlineExtent(settings, overrides.outlineMode)).map(cells) : [],
      rgba: ['r', 'g', 'b', 'a'].map((c) => Number(value(`cl_crosshaircolor_${c}`) ?? 255)),
      outlineRgba: outlineOn ? ['r', 'g', 'b', 'a'].map((c) => Number(value(`cl_crosshairoutline_${c}`) ?? (c === 'a' ? 255 : 0))) : null,
    },
  };
}

// Crosshair settings CS:GO gained later, with the update that added each (official
// release notes). A classic config without one had it off, not at the pre-update
// (2026) defaults the parser would fill in: it didn't exist yet, or it was off by
// default (recoil was cheat-protected until CS2).
const ERA = [
  ['cl_crosshair_drawoutline', '2013-05-22'],
  ['cl_crosshairgap_useweaponvalue', '2014-08-01'],
  ['cl_crosshair_t', '2017-09-26'],
  ['cl_crosshair_recoil', '2018-02-28'],
];
const CS2_RELEASE = '2023-09-27';

/** First and last day a "2014", "2014-07" or "2014-07-16" date can mean, or null. */
function dateSpan(d) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(d ?? ''));
  return m ? [`${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`, `${m[1]}-${m[2] ?? '12'}-${m[3] ?? '31'}`] : null;
}

/** A classic entry's dated config as the record shape convertPlayer reads, plus notes on what was assumed. */
export function classicRecord(year, p) {
  const convars = { ...(p.config.convars ?? {}) };
  const notes = [];
  if (Object.keys(convars).some((k) => k.startsWith('cl_crosshair'))) {
    const span = dateSpan(p.config.date);
    const notYet = [], cheat = [], byDefault = [];
    for (const [k, added] of ERA) {
      if (convars[k] !== undefined) continue;
      if (span && span[1] < added) notYet.push(k);
      else if (k === 'cl_crosshair_recoil') {
        if (span && span[0] >= CS2_RELEASE) continue;  // a CS2 config: the parser's default applies
        cheat.push(k);
      } else byDefault.push(k);
      convars[k] = '0';
    }
    // with the outline off its thickness does nothing; set it so no "default used" note is shown for it
    if (convars.cl_crosshair_drawoutline === '0' && convars.cl_crosshair_outlinethickness === undefined) convars.cl_crosshair_outlinethickness = '1';
    if (notYet.length) notes.push({ code: 'era-features-off', text: `Not in this config because the setting didn't exist yet, so off: ${notYet.join(', ')}.` });
    if (byDefault.length) notes.push({ code: 'era-default-off', text: `Not in this config, so off, as CS:GO had it by default: ${byDefault.join(', ')}.` });
    if (cheat.length) notes.push({ code: 'era-recoil-cheat', text: 'cl_crosshair_recoil was cheat-protected in CS:GO, so off.' });
    const alpha = Number(convars.cl_crosshairalpha);
    if (Number.isFinite(alpha) && (alpha < 0 || alpha > 255)) {
      const v = alpha < 0 ? 0 : 255;
      notes.push({ code: 'alpha-clamped', text: `cl_crosshairalpha ${convars.cl_crosshairalpha} is outside 0-255; the old game drew it as ${v}.` });
      convars.cl_crosshairalpha = String(v);
    }
  }
  return { slug: `${year}/${p.id}`, convars, tables: { 'Video Settings': p.config.video ?? {} }, notes };
}

function convertSafely(rec) {
  try {
    return convertPlayer(rec);
  } catch (e) {
    const { height, source } = playerHeight(rec);
    return { kind: 'blocked', height, heightSource: source, error: String(e.message ?? e) };
  }
}

function buildClassic() {
  let classic;
  try {
    classic = JSON.parse(readFileSync(join(ROOT, 'data', 'classic.json'), 'utf8'));
  } catch {
    return null;
  }
  const out = {};
  for (const y of classic.years) {
    for (const p of y.players) {
      if (!p.config) continue;
      const rec = classicRecord(y.year, p);
      const x = convertSafely(rec);
      if (x.warnings) x.warnings = [...rec.notes, ...x.warnings];
      out[`${y.year}/${p.id}`] = x;
    }
  }
  return out;
}

function build() {
  const index = JSON.parse(readFileSync(join(ROOT, 'data', 'index.json'), 'utf8'));
  const players = {};
  let failed = 0;
  for (const { slug } of [...index.players].sort((a, b) => (a.slug < b.slug ? -1 : 1))) {
    let rec;
    try {
      rec = JSON.parse(readFileSync(join(ROOT, 'data', 'players', `${slug}.json`), 'utf8'));
    } catch {
      continue;
    }
    try {
      players[slug] = convertPlayer(rec);
    } catch (e) {
      failed++;
      const { height, source } = playerHeight(rec);
      players[slug] = { kind: 'blocked', height, heightSource: source, error: String(e.message ?? e) };
    }
    if (players[slug].error || players[slug].blockers) console.error(`${slug}: ${players[slug].error ?? players[slug].blockers.join(' ')}`);
  }
  // one player per line keeps the weekly diff readable
  const lines = (obj) => Object.entries(obj).map(([k, p]) => `${JSON.stringify(k)}:${JSON.stringify(p)}`).join(',\n');
  const classic = buildClassic();
  const tail = classic ? `,\n"classic":{\n${lines(classic)}\n}` : '';
  return { text: `{"reference":${JSON.stringify(REFERENCE)},\n"players":{\n${lines(players)}\n}${tail}}\n`, count: Object.keys(players).length, failed };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = join(ROOT, 'data', 'crosshair.json');
  const { text, count, failed } = build();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(out, 'utf8'); } catch { /* missing */ }
    if (current !== text) {
      console.error('data/crosshair.json is out of date: run node scraper/crosshair.mjs');
      process.exit(1);
    }
    console.log(`data/crosshair.json up to date (${count} players)`);
  } else {
    writeFileSync(out, text);
    console.log(`data/crosshair.json: ${count} players, ${failed} failed`);
  }
  // a broken converter must not publish a site without crosshairs
  if (failed > count / 10) process.exit(1);
}
