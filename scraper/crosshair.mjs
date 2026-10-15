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
 * their family (Valve kept both numbers and families in the new style list);
 * style 2's gap is an offset from the weapon's spread, as it was in the old game.
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
const { nativeOutlineExtent } = await lib('settings/native.js');
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
  'cl_crosshair_dynamic_spread_limit', 'cl_crosshair_sniper_width', 'cl_ironsight_usecrosshaircolor',
  'cl_ironsight_dot_scale', 'cl_crosshair_screen_height',
];
// Crosshair cvars the converter doesn't write, with CS2's default and range (build 2000930 dump). A paste sets
// every one that shapes its crosshair, so nothing of the visitor's own crosshair carries over, as a crosshair
// share paste does. Which style uses which, from the game's crosshair settings menu (settingsmenu_crosshair.js,
// 2000930): the classic split sliders for style 2, the split ratio also as style 9's quadrant size, the spread
// limit for the dynamic styles 0, 1 and 7; the iron-sight dot for every style.
const EXTRA = {
  cl_crosshair_dynamic_splitdist: [3, 0, 127],
  cl_crosshair_dynamic_splitalpha_innermod: [0, 0, 1],
  cl_crosshair_dynamic_splitalpha_outermod: [1, 0.3, 1],
  cl_crosshair_dynamic_maxdist_splitratio: [1, 0, 1],
  cl_crosshair_dynamic_spread_limit: [255, 0, 255],
  cl_ironsight_usecrosshaircolor: [0, 0, 1],
  cl_ironsight_dot_scale: [1, 0.1, 2],
};
const STYLES_OF = {
  cl_crosshair_dynamic_splitdist: [2], cl_crosshair_dynamic_splitalpha_innermod: [2],
  cl_crosshair_dynamic_splitalpha_outermod: [2], cl_crosshair_dynamic_maxdist_splitratio: [2, 9],
  cl_crosshair_dynamic_spread_limit: [0, 1, 7],
};
const appliesTo = (name, style) => !STYLES_OF[name] || STYLES_OF[name].includes(style);
// CS2's defaults (2000930) for the core cvars a new-format listing may leave out
const CORE_DEFAULTS = [
  ['cl_crosshairstyle', 7], ['cl_crosshair_length', 8], ['cl_crosshair_thickness', 2], ['cl_crosshair_gap', 4],
  ['cl_crosshairdot', 0], ['cl_crosshair_t', 0], ['cl_crosshair_drawoutline', 1],
  ['cl_crosshairoutline_r', 0], ['cl_crosshairoutline_g', 0], ['cl_crosshairoutline_b', 0], ['cl_crosshairoutline_a', 255],
  ['cl_crosshair_recoil', 1], ['cl_crosshaircolor_r', 0], ['cl_crosshaircolor_g', 255], ['cl_crosshaircolor_b', 0],
  ['cl_crosshaircolor_a', 255],
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
  .replace(/^Exported style 2 keeps the old style family\. .*$/, 'Exported as style 2, Dynamic Cross (Classic), which like the old ' +
    "style 2 places the bars at the weapon's spread plus the gap, so the gap is the old one without Static Cross's fixed 4 px " +
    'and can be negative. The at-rest shape matches the old one with a rifle; this is from the game code, not checked in game.')
  .replace(/^Exported style 5 keeps the old style family\. .*$/, 'Exported as style 5, Dynamic Cross (Legacy/Shot Feedback), which ' +
    'like the old style 5 rests at this gap and widens when you fire; how far it widens is not checked in game.')
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

/** Add the EXTRA cvars that shape this crosshair (value from the config, clamped to CS2's range, else CS2's
 * default) before cl_crosshair_screen_height, and drop outline colour lines when the outline is off. */
function complete(commands, cv) {
  const value = (name) => commands.find((c) => c.startsWith(`${name} `))?.split(' ')[1];
  const style = Number(value('cl_crosshairstyle'));
  // outline colour only matters with an outline (CS2's default outline is on)
  const outline = value('cl_crosshair_drawoutline');
  const out = outline === undefined || Number(outline) > 0 ? commands
    : commands.filter((c) => !c.startsWith('cl_crosshairoutline_'));
  const have = new Set(out.map((c) => c.split(' ')[0]));
  const add = [];
  for (const [name, [dflt, lo, hi]] of Object.entries(EXTRA)) {
    if (have.has(name) || !appliesTo(name, style)) continue;
    const v = cv[name] === undefined ? null : numeric(cv[name]);
    add.push(`${name} ${v === null ? dflt : Number(Math.min(hi, Math.max(lo, Number(v))).toFixed(4))}`);
  }
  const at = out.findIndex((c) => c.startsWith('cl_crosshair_screen_height '));
  return at < 0 ? [...out, ...add] : [...out.slice(0, at), ...add, ...out.slice(at)];
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
  // a listing may leave out core cvars: CS2's defaults, so the paste still defines everything
  const listed = new Set(commands.map((c) => c.split(' ')[0]));
  const missing = CORE_DEFAULTS.filter(([name]) => !listed.has(name)).map(([name, d]) => `${name} ${d}`);
  commands.splice(0, 0, ...missing.filter((c) => c.startsWith('cl_crosshairstyle ')));
  commands.push(...missing.filter((c) => !c.startsWith('cl_crosshairstyle ')));
  const authored = numeric(cv.cl_crosshair_screen_height ?? '');
  const h = authored !== null && Number(authored) >= 240 ? Math.round(Number(authored)) : height;
  commands.push(`cl_crosshair_screen_height ${h}`);
  commands.splice(0, commands.length, ...complete(commands, cv));
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
  // The old painter's colour switch had presets 0-4, 5 for the r/g/b values and a default branch of green 50/250/50
  // for any other value (CS:GO's game code, 2016-17; CS:S had the same switch), so an index such as 6 or 7 drew green.
  const own = [];
  const ci = legacy.findIndex(([k]) => k === 'cl_crosshaircolor');
  if (ci >= 0 && !(Math.trunc(Number(numeric(legacy[ci][1]))) >= 0 && Math.trunc(Number(numeric(legacy[ci][1]))) <= 5)) {
    own.push({ code: 'color-index-default', text: `Old colour index ${legacy[ci][1]} is not a preset; the old game drew it in its ` +
      'default green (50, 250, 50) and ignored the stored RGB, so that green is used.' });
    legacy[ci] = ['cl_crosshaircolor', '1'];
  }
  const parsed = parseLegacyTextWithNotes(legacy.map(([k, v]) => `${k} ${v}`).join('\n'));
  const options = { oldHeight: height, currentHeight: height, authoredHeight: height, styleTarget: 'family' };
  let report = infer({ settings: parsed.config, options, selectedModelId: COMMUNITY_MODEL.id });
  // An old style 2/3 crosshair without arms (old arm length 0 px: a dot) never moved, and CS2's style 2 would push the
  // export's short arms (kept inside the dot) out by the weapon's spread, so it stays a Static Cross.
  if (!report.blockers.length && [2, 3].includes(report.settings.style) && report.legacy?.length === 0)
    report = infer({ settings: parsed.config, options: { ...options, styleTarget: 'static' }, selectedModelId: COMMUNITY_MODEL.id });
  if (report.blockers.length) return { kind: 'blocked', height, heightSource: source, blockers: report.blockers.map(pageText) };

  const overrides = mergedExportOverrides(report);
  const settings = report.settings, native = report.chosen.native;
  // old style 3 never split, so it gets CS2 style 2's no-split values (ratio 1, inner 0, outer 1)
  const cv = settings.style === 3 ? { ...rec.convars, cl_crosshair_dynamic_maxdist_splitratio: '1',
    cl_crosshair_dynamic_splitalpha_innermod: '0', cl_crosshair_dynamic_splitalpha_outermod: '1' } : (rec.convars ?? {});
  // every line group (colour, opacity, outline colour, recoil ...), not only the ones the old config set,
  // then the cvars the converter doesn't write: the paste fully defines the crosshair
  let commands = complete(exportQuantCFG(report, null).split(';'), cv);
  const value = (name) => commands.find((c) => c.startsWith(`${name} `))?.split(' ')[1];
  // Style 2 (old from 12 Feb 2014, and old 3) drew its bars at the weapon's spread plus the gap, in whole pixels
  // (CS:GO's game code, 2016-17), and CS2's style 2 does the same: Valve allowed negative gaps for this style only
  // (30 Sep 2026), and two decompiles of the current client draw it at spread + gap. Static Cross adds a fixed 4
  // instead, so the style-2 gap is the static one minus 4, which is floor(old gap) + ceil(thickness / 2) and can be
  // negative (the cvar takes -3840..3840). The preview keeps the static shape: the at-rest look with a rifle.
  const gap = value('cl_crosshairstyle') === '2' ? native.gap - 4 : native.gap;
  if (gap !== native.gap) commands = commands.map((c) => (c.startsWith('cl_crosshair_gap ') ? `cl_crosshair_gap ${gap}` : c));
  const flags = { dot: Boolean(settings.dot), t_style: overrides.t_style ?? Boolean(settings.t_style) };
  const geometry = forward(native, height, COMMUNITY_MODEL);
  const filled = defaultsWarning(parsed.notes);
  const outlineOn = Number(value('cl_crosshair_drawoutline')) > 0;
  return {
    kind: 'converted',
    height,
    heightSource: source,
    commands,
    native: { length: native.length, thickness: native.thickness, gap },
    shape: report.shapeCheck?.status ?? null,
    // legacy-rounding-disagreement compares with a truncating model that CS:GO's code (round to nearest, ties to even)
    // and pre-update captures (crosshairrestore.com) contradict, so it would only cast doubt on correct pixels
    warnings: [...own, ...(filled ? [filled] : []), ...report.warnings]
      .filter((w) => !GENERIC.has(w.code) && w.code !== 'legacy-rounding-disagreement')
      .map((w) => ({ code: w.code, text: pageText(w.text ?? w.message) })),
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
// Style behaviour CS:GO changed (official release notes): until 5 Jun 2013 the
// style 4 gap changed per weapon, and until 12 Feb 2014 style 2 was the
// original classic crosshair that didn't show weapon accuracy.
const STYLE4_STATIC_GAP = '2013-06-05';
const STYLE2_ACCURATE = '2014-02-12';

/** First and last day a "2014", "2014-07" or "2014-07-16" date can mean, or null. */
function dateSpan(d) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(String(d ?? ''));
  return m ? [`${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}`, `${m[1]}-${m[2] ?? '12'}-${m[3] ?? '31'}`] : null;
}

/** A classic entry's dated config as the record shape convertPlayer reads, plus notes on what was assumed. */
export function classicRecord(year, p, key = year) {
  const convars = { ...(p.config.convars ?? {}) };
  const notes = [];
  const rewrite = {};  // converter warning code -> text for this era
  if (Object.keys(convars).some((k) => k.startsWith('cl_crosshair'))) {
    // a known window ("saved between ...") is narrower than the date label
    // A window ends on the update whose setting the file lacks, so it was saved before that day.
    const w = p.config.window;
    const fromWindow = Array.isArray(w) && w.length === 2;
    const span = fromWindow ? w : dateSpan(p.config.date);
    const before = (day) => Boolean(span) && (fromWindow ? span[1] <= day : span[1] < day);
    const csgoEra = Boolean(span) && span[1] < CS2_RELEASE;
    // CS:GO's cl_crosshairstyle had no bounds, and a style that is none of 2, 3 or 4 took the same path as style 5:
    // at rest at round(4 x height / 1200 + gap), wider while firing (CS:GO's game code, 2016-17)
    const raw = Number(String(convars.cl_crosshairstyle ?? '').trim());
    if (csgoEra && Number.isFinite(raw) && Math.trunc(raw) >= 6) {
      notes.push({ code: 'style-unlisted', text: `Style ${convars.cl_crosshairstyle} was not a listed style, but CS:GO accepted it and drew ` +
        "it like style 5: at rest at round(4 × height / 1200 + gap), wider while firing (CS:GO's game code, 2016-17), so it is " +
        'converted as style 5.' });
      convars.cl_crosshairstyle = '5';
    }
    const style = String(convars.cl_crosshairstyle ?? '').trim();
    const notYet = [], cheat = [], byDefault = [];
    let outlineOn = null;
    if (style === '4' && before(STYLE4_STATIC_GAP) && convars.cl_crosshairgap_useweaponvalue === undefined) {
      // the converter's weapon-gap-dropped warning then says what that means now
      convars.cl_crosshairgap_useweaponvalue = '1';
      rewrite['weapon-gap-dropped'] = 'Until 5 Jun 2013 the style 4 gap changed per weapon; the current game has one gap, so the ' +
        'export uses the gap without the weapon value.';
    }
    if (style === '2' && before(STYLE2_ACCURATE)) {
      // not CS2's accurate style 2 but the shot-feedback kind, like style 5 (16 Jul 2014), whose at-rest rule it gets
      convars.cl_crosshairstyle = '5';
      notes.push({ code: 'era-style-2', text: 'Style 2 was the original classic crosshair until 12 Feb 2014: it widened when you fired but ' +
        "didn't show weapon accuracy, which is what style 5 (added July 2014) does too, so it is exported as style 5. CS2's style 2 " +
        'is the later, accurate version.' });
      rewrite['legacy-style-5-gap'] = 'At rest the bars are placed at round(4 × height / 1200 + gap), the rule CS:GO kept for style 5; ' +
        'no game code or capture from 2012-13 confirms it for the original style 2.';
    }
    for (const [k, added] of ERA) {
      if (convars[k] !== undefined) continue;
      if (before(added)) notYet.push(k);
      else if (k === 'cl_crosshair_recoil') {
        if (span && span[0] >= CS2_RELEASE) continue;  // a CS2 config: the parser's default applies
        cheat.push(k);
      } else if (k === 'cl_crosshair_drawoutline') {
        // on by default (width 1) in CS:GO's 2016-17 code and in CS2; a game-written config of that time always lists it
        convars[k] = '1';
        if (convars.cl_crosshair_outlinethickness === undefined) convars.cl_crosshair_outlinethickness = '1';
        outlineOn = { code: 'era-default-outline', text: 'Not in this config, so on with width 1, the default in CS:GO (2016-17 game ' +
          'code) and in CS2; the default in 2013-2015 is not documented.' };
        continue;
      } else byDefault.push(k);
      convars[k] = '0';
    }
    // CS:GO's outline thickness had a minimum of 0.1 (game code; game-written configs store "0.100000"), so a typed 0
    // with the outline on drew 0.1: one pixel on the top and left edges
    const ot = Number(convars.cl_crosshair_outlinethickness);
    if (csgoEra && Number(convars.cl_crosshair_drawoutline) > 0 && Number.isFinite(ot) && ot < 0.1) {
      notes.push({ code: 'outline-min', text: `cl_crosshair_outlinethickness ${convars.cl_crosshair_outlinethickness} is below CS:GO's ` +
        'minimum of 0.1; the old game used 0.1, which drew the outline on the top and left edges only.' });
      convars.cl_crosshair_outlinethickness = '0.1';
    }
    // with the outline off its thickness does nothing; set it so no "default used" note is shown for it
    if (convars.cl_crosshair_drawoutline === '0' && convars.cl_crosshair_outlinethickness === undefined) convars.cl_crosshair_outlinethickness = '1';
    if (notYet.length) notes.push({ code: 'era-features-off', text: `Not in this config because the setting didn't exist yet, so off: ${notYet.join(', ')}.` });
    if (byDefault.length) notes.push({ code: 'era-default-off', text: `Not in this config, so off, as CS:GO had it by default: ${byDefault.join(', ')}.` });
    if (outlineOn) notes.push(outlineOn);
    if (cheat.length) notes.push({ code: 'era-recoil-cheat', text: 'cl_crosshair_recoil was cheat-protected in CS:GO, so off.' });
    const alpha = Number(convars.cl_crosshairalpha);
    if (Number.isFinite(alpha) && (alpha < 0 || alpha > 255)) {
      const v = alpha < 0 ? 0 : 255;
      notes.push({ code: 'alpha-clamped', text: `cl_crosshairalpha ${convars.cl_crosshairalpha} is outside 0-255; the old game drew it as ${v}.` });
      convars.cl_crosshairalpha = String(v);
    }
  }
  // the crosshair is converted at the resolution its own source gives, when that differs from the video settings shown
  const video = { ...(p.config.video ?? {}) };
  if (p.config.crosshair_resolution) video.Resolution = p.config.crosshair_resolution;
  return { slug: `${key}/${p.id}`, convars, tables: { 'Video Settings': video }, notes, rewrite };
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
      const key = y.key ?? y.year;  // a lineup group has its own key
      const rec = classicRecord(y.year, p, key);
      const x = convertSafely(rec);
      if (x.warnings) x.warnings = [...rec.notes, ...x.warnings.map((w) => (rec.rewrite[w.code] ? { ...w, text: rec.rewrite[w.code] } : w))];
      if (p.config.crosshair_resolution && x.heightSource === 'resolution') x.heightSource = 'crosshair-source';
      out[`${key}/${p.id}`] = x;
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
