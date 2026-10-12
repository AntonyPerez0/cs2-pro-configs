/**
 * Build-specific crosshair cvar inventory, as data.
 *
 * Current build: 2000922 (bottom of this file). The 2000914 tables below are kept for history.
 * Build 2000924 (GameTracking-CS2 7193ca8, 2026-10-02) was checked on 2026-10-03: its crosshair convars, ranges,
 * descriptions, Panorama settings and shader equal 2000922; only workshop_cvar_whitelist.txt changed (old
 * crosshair cvars removed, new ones added). The 2000922 tables therefore also describe 2000924 (source
 * ledger S19).
 * Evidence for 2000914: SteamTracking / GameTracking-CS2, commit
 * 98da94fc084706334e85fcde5105d02224e30f0a, `DumpSource2/convars.txt`, re-read 2026-09-23.
 * Descriptions support names, ranges and which fields claim to scale. They do NOT reveal
 * the pixel arithmetic, a quantizer, a gap origin or a migration callback.
 *
 * This module is the single code source of truth for the table. Docs may quote it; do not
 * hand-copy the numbers into a second source of truth inside `lib/`.
 */
import { NATIVE_RANGES, NATIVE_RANGES_2000922, GAP_CVAR_RANGE_2000922 } from './native.js';

export const CVAR_INVENTORY_VERSION = 'cvar-inventory-v1';
export const INVENTORY_BUILD = '2000914';
export const INVENTORY_RETRIEVED = '2026-09-23';

/** New geometry cvars. Ranges are reused from `NATIVE_RANGES`, the export validator. */
export const NEW_CVARS = Object.freeze({
  length: Object.freeze({
    name: 'cl_crosshair_length',
    default: 8,
    min: NATIVE_RANGES.length.min,
    max: NATIVE_RANGES.length.max,
    description: 'Length of each crosshair bar, scaled with screen resolution.',
    scalingStatedInDump: true,
  }),
  thickness: Object.freeze({
    name: 'cl_crosshair_thickness',
    default: 2,
    min: NATIVE_RANGES.thickness.min,
    max: NATIVE_RANGES.thickness.max,
    description: 'Thickness of the crosshair bars and circle, scaled with screen resolution (minimum 1 pixel).',
    scalingStatedInDump: true,
  }),
  gap: Object.freeze({
    name: 'cl_crosshair_gap',
    default: 4,
    min: NATIVE_RANGES.gap.min,
    max: NATIVE_RANGES.gap.max,
    // Effectively the contested statement: the dump does NOT say gap scales.
    description: 'Offset added to the gap between the crosshair center and the bars.',
    scalingStatedInDump: false,
  }),
  authoredHeight: Object.freeze({
    name: 'cl_crosshair_screen_height',
    default: 1080,
    min: NATIVE_RANGES.authoredHeightMin,
    max: null,
    description: 'Resolution at which size settings were authored; changes when a size setting is updated.',
    scalingStatedInDump: false,
  }),
});

/** Names still listed hidden in the build, with no license to export them. `cl_crosshairsize`
 * defaults to 3.9, but a user's console showed 100 (a stored or migrated value), so never assume
 * the default is what a player has. */
export const HIDDEN_LEFTOVERS = Object.freeze([
  Object.freeze({ name: 'cl_crosshairsize', default: 3.9, min: null, max: null, note: 'Hidden legacy size; do not export.' }),
  Object.freeze({ name: 'cl_crosshairthickness', default: 0.6, min: null, max: null, note: 'Hidden legacy thickness; do not export.' }),
  Object.freeze({ name: 'cl_crosshairalpha', default: 200, min: 0, max: 255, note: 'Hidden legacy alpha; do not export.' }),
]);

/** Absent from the 2000914 crosshair grep. Absence is a snapshot fact, not a promise.
 * From 2000913 on, five of these (`cl_crosshair_outlinethickness`, `cl_crosshaircolor`,
 * `cl_crosshairgap`, `cl_crosshairgap_useweaponvalue`, `cl_fixedcrosshairgap`) remain as string
 * literals in `client_strings.txt`, which suggests the game migrates old values in code.
 * `cl_crosshairusealpha` is gone entirely. */
export const REMOVED_NAMES = Object.freeze([
  'cl_crosshairgap',
  'cl_crosshairusealpha',
  'cl_crosshaircolor',
  'cl_crosshair_outlinethickness',
  'cl_crosshairgap_useweaponvalue',
  'cl_fixedcrosshairgap',
]);

/** Style identifiers were reassigned on this build. Integer meaning is build-specific. */
export const STYLE_ON_BUILD_2000914 = Object.freeze([
  Object.freeze({ id: 0, label: 'Dynamic Cross', tracksWeaponInaccuracy: true, modeledHere: false }),
  Object.freeze({ id: 1, label: 'Dynamic Circle', tracksWeaponInaccuracy: true, modeledHere: false }),
  Object.freeze({ id: 2, label: 'Dynamic Cross (Legacy)', tracksWeaponInaccuracy: false, modeledHere: false }),
  Object.freeze({ id: 3, label: 'Static Circle', tracksWeaponInaccuracy: false, modeledHere: false }),
  Object.freeze({ id: 4, label: 'Static Cross', tracksWeaponInaccuracy: false, modeledHere: true }),
  Object.freeze({ id: 5, label: 'Static Cross (Shot Feedback)', tracksWeaponInaccuracy: false, modeledHere: false }),
  Object.freeze({ id: 6, label: 'Dot Only', tracksWeaponInaccuracy: false, modeledHere: false }),
  Object.freeze({ id: 7, label: 'Dynamic Quad', tracksWeaponInaccuracy: true, modeledHere: false }),
]);

export const STYLE_DEFAULT_ON_BUILD_2000914 = 7;
export const STYLE_MAX_ON_BUILD_2000914 = 7;

/**
 * Description-level facts, kept separate from the tables so tests and the structural
 * hypothesis can cite them without re-parsing prose. `gapScalingStatedInDump` is the
 * one that makes gap scaling a hypothesis rather than a reading of the dump.
 */
export const DUMP_DESCRIPTION_FACTS = Object.freeze({
  build: INVENTORY_BUILD,
  retrieved: INVENTORY_RETRIEVED,
  gapScalingStatedInDump: false,
  lengthScalingStatedInDump: true,
  thicknessScalingStatedInDump: true,
});

/**
 * Build 2000922 (Oct 1 2026) inventory. Historical 2000914 exports above stay as they were.
 * Evidence: GameTracking-CS2 commit 6ac247908a83c309b37314fd097c47dc78103746, `convars.txt`
 * sha256 667b1d2ecb36673097ea14058ef66447c3148acbf11f496a77eba64243e2fec4.
 */
export const CURRENT_INVENTORY_BUILD = '2000922';
export const CURRENT_INVENTORY_RETRIEVED = '2026-10-01';
export const CURRENT_INVENTORY_SOURCE = Object.freeze({
  commit: '6ac247908a83c309b37314fd097c47dc78103746',
  convarsSha256: '667b1d2ecb36673097ea14058ef66447c3148acbf11f496a77eba64243e2fec4',
});

export const NEW_CVARS_2000922 = Object.freeze({
  length: Object.freeze({ ...NEW_CVARS.length, min: NATIVE_RANGES_2000922.length.min, max: NATIVE_RANGES_2000922.length.max }),
  thickness: Object.freeze({ ...NEW_CVARS.thickness, min: NATIVE_RANGES_2000922.thickness.min, max: NATIVE_RANGES_2000922.thickness.max }),
  gap: Object.freeze({
    ...NEW_CVARS.gap, min: GAP_CVAR_RANGE_2000922.min, max: GAP_CVAR_RANGE_2000922.max,
    staticCrossUiRange: Object.freeze({ min: NATIVE_RANGES_2000922.gap.min, max: NATIVE_RANGES_2000922.gap.max }),
    // The UI floor is -10 for style 2 only; static styles' UI is 0..128; the cvar accepts -3840..3840.
    note: 'Negative values are officially enabled for Classic Dynamic only; unverified for Static Cross.',
  }),
  authoredHeight: NEW_CVARS.authoredHeight,
});

const outline = (suffix, def, description) =>
  Object.freeze({ name: `cl_crosshairoutline_${suffix}`, default: def, min: 0, max: 255, description });
export const OUTLINE_COLOR_CVARS = Object.freeze({
  r: outline('r', 0, 'Crosshair outline red'),
  g: outline('g', 0, 'Crosshair outline green'),
  b: outline('b', 0, 'Crosshair outline blue'),
  a: outline('a', 255, 'Crosshair outline opacity'),
});

export const SCOPE_DOT_CVARS = Object.freeze({
  scale: Object.freeze({ name: 'cl_ironsight_dot_scale', default: 1, min: 0.1, max: 2, description: 'Scope dot scale' }),
  useCrosshairColor: Object.freeze({ name: 'cl_ironsight_usecrosshaircolor', default: false, min: null, max: null, description: null }),
});

// `cl_crosshair_sniper_width` (default 1) has no cvar range in the dump; its UI slider is 1..6.

// UI text from csgo_english.txt at 2000922. For 5 the convar description says "Static Cross
// (Shot Feedback)" and the tooltip "Dynamic Cross (Legacy)", which conflict with the UI label.
const UI_LABELS_2000922 = { 2: 'Dynamic Cross (Classic)', 5: 'Dynamic Cross (Legacy/Shot Feedback)', 7: 'Dynamic Quadrant' };
/** Style ids 0..9. "Tracks inaccuracy" cites the build 2000918 description; 2000922 dropped that sentence. */
export const STYLE_ON_BUILD_2000922 = Object.freeze([
  ...STYLE_ON_BUILD_2000914.map(style =>
    Object.freeze({ ...style, uiLabel: UI_LABELS_2000922[style.id] ?? style.label })),
  Object.freeze({ id: 8, label: 'Static Square', uiLabel: 'Static Square', tracksWeaponInaccuracy: false, modeledHere: false }),
  Object.freeze({ id: 9, label: 'Static Quad', uiLabel: 'Static Quadrant', tracksWeaponInaccuracy: false, modeledHere: false }),
]);
export const STYLE_DEFAULT_ON_BUILD_2000922 = 7;
export const STYLE_MAX_ON_BUILD_2000922 = 9;
