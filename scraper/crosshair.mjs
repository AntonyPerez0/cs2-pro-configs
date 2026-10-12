#!/usr/bin/env node
/*
 * Convert every pro's pre-patch crosshair (data/players/<slug>.json, legacy
 * cl_crosshair* convars from settings.gg) into the crosshair cvars CS2 has
 * used since the Sept 22, 2026 "Rush Hour" update, with the vendored
 * community reference converter (scraper/vendor/small-indie-crosshair-company).
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
  'cl_crosshair_sniper_width', 'cl_crosshair_screen_height',
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
    height: h,
    heightSource: authored !== null ? 'config' : source,
    commands,
    native,
    shape: null,
    warnings: [{ code: 'already-new-format', text: 'settings.gg already lists this crosshair in the format CS2 uses since the Sept 22, 2026 update, so it is copied as-is instead of converted.' }],
    preview: previewOf(native, h, flags, int('cl_crosshair_drawoutline', 0), value),
  };
}

export function convertPlayer(rec) {
  const { height, source } = playerHeight(rec);
  if (NEW_ONLY.some((k) => rec.convars?.[k] !== undefined)) return passThrough(rec, height, source);
  // numbers and booleans only: anything else (e.g. a value with ';') is dropped
  // here rather than letting it reject the whole crosshair
  const legacy = Object.entries(rec.convars ?? {}).filter(([k, v]) => k.startsWith('cl_crosshair') && numeric(v) !== null);
  const parsed = parseLegacyTextWithNotes(legacy.map(([k, v]) => `${k} ${v}`).join('\n'));
  const options = { oldHeight: height, currentHeight: height, authoredHeight: height, styleTarget: 'family' };
  const report = infer({ settings: parsed.config, options, selectedModelId: COMMUNITY_MODEL.id });
  if (report.blockers.length) return { height, heightSource: source, blockers: report.blockers };

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
    height,
    heightSource: source,
    commands,
    native: { length: native.length, thickness: native.thickness, gap: native.gap },
    shape: report.shapeCheck?.status ?? null,
    warnings: [...(filled ? [filled] : []), ...report.warnings]
      .filter((w) => !GENERIC.has(w.code)).map((w) => ({ code: w.code, text: w.text ?? w.message })),
    preview: {
      fill: rectangles(geometry, flags).map(cells),
      outline: outlineOn ? outlineRectangles(geometry, flags, nativeOutlineExtent(settings, overrides.outlineMode)).map(cells) : [],
      rgba: ['r', 'g', 'b', 'a'].map((c) => Number(value(`cl_crosshaircolor_${c}`) ?? 255)),
      outlineRgba: outlineOn ? ['r', 'g', 'b', 'a'].map((c) => Number(value(`cl_crosshairoutline_${c}`) ?? (c === 'a' ? 255 : 0))) : null,
    },
  };
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
      players[slug] = { ...playerHeight(rec), error: String(e.message ?? e) };
    }
    if (players[slug].error || players[slug].blockers) console.error(`${slug}: ${players[slug].error ?? players[slug].blockers.join(' ')}`);
  }
  // one player per line keeps the weekly diff readable
  const body = Object.entries(players).map(([slug, p]) => `${JSON.stringify(slug)}:${JSON.stringify(p)}`).join(',\n');
  return { text: `{"reference":${JSON.stringify(REFERENCE)},\n"players":{\n${body}\n}}\n`, count: Object.keys(players).length, failed };
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
