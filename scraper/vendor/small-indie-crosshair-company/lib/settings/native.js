import { height as validHeight, integer, bool, finite } from './validation.js';

/** Single source of the new-cvar integer ranges. Build 2000914. Do not change the numbers. */
export const NATIVE_RANGES = Object.freeze({
  length: Object.freeze({ min: 0, max: 255 }),
  thickness: Object.freeze({ min: 0, max: 31 }),
  gap: Object.freeze({ min: 0, max: 128 }),
  authoredHeightMin: 240,
});

/** Build 2000922: thickness 0..32. `gap` is the static-cross range used by export and search. */
export const NATIVE_RANGES_2000922 = Object.freeze({
  length: Object.freeze({ min: 0, max: 255 }),
  thickness: Object.freeze({ min: 0, max: 32 }),
  gap: Object.freeze({ min: 0, max: 128 }),
  authoredHeightMin: 240,
});
/** The cvar itself accepts this range on 2000922; negative gaps are officially Classic Dynamic only. */
export const GAP_CVAR_RANGE_2000922 = Object.freeze({ min: -3840, max: 3840 });

export function validateNative(n, ranges = NATIVE_RANGES) {
  integer(n.length,'New length',ranges.length.min,ranges.length.max);
  integer(n.thickness,'New thickness',ranges.thickness.min,ranges.thickness.max);
  integer(n.gap,'New gap',ranges.gap.min,ranges.gap.max);
  validHeight(n.authoredHeight);
}

/** Share codes store the colour index in three bits, so 6 and 7 decode but are not game presets. */
export const colorIndexUnknown = settings => settings.color === 6 || settings.color === 7;
export const COLOR_INDEX_NOTE = index => `Old colour index ${index} is not a game preset; the stored RGB is used.`;

export function rgba(settings) {
  bool(settings.alpha_enabled,'Alpha enabled');
  const presets = [[250,50,50],[50,250,50],[250,250,50],[50,50,250],[50,250,250]];
  const color = settings.color >= 5 && settings.color <= 7 && Number.isInteger(settings.color) ? settings.rgb : presets[settings.color];
  if (!Array.isArray(color) || color.length!==3) throw new Error('Unsupported legacy color preset.');
  color.forEach(v=>integer(v,'RGB',0,255)); integer(settings.alpha,'Alpha',0,255);
  return {rgb:[...color],alpha:settings.alpha_enabled ? settings.alpha : 200};
}

/** Legacy outline to `cl_crosshair_drawoutline` (0 none, 1 full, 2 half). Old widths below 1 drew
 * only the top-left edge; Valve's September 24 2026 half outline replaces them (issue #11). A zero
 * width typed in a CFG drew no visible outline; a share-code zero is only a rounded small width.
 * The half mapping matches one user capture of the current game (issue #11); the full one has none. */
export function outlineMode(settings) {
  if (!bool(settings.outline, 'outline')) return 0;
  const width = finite(settings.outline_width ?? 1, 'Outline width', 0);
  return width === 0 && !settings.outline_width_rounded ? 0 : width < 1 ? 2 : 1;
}

/** True when an enabled outline has width 0 only because the share code rounds to 0.5 steps. */
export const outlineRounded = settings => !!settings.outline && settings.outline_width === 0 && settings.outline_width_rounded === true;
export const OUTLINE_ROUNDED_NOTE = 'Old share codes store outline thickness in 0.5 steps, so a stored 0 with the outline on ' +
  'means a thin outline below 0.5.';

/** Old maximum of cl_crosshair_outlinethickness; larger typed values drew as 3. */
export const OLD_OUTLINE_MAX = 3;
/** Outline pixels added beyond a bar edge, `{ low, high }` = left/top and right/bottom.
 * Old source: `DrawFilledRect(x0-t, y0-t, x1+t, y1+t)` with float t truncated to int, so at
 * screen-positive coordinates the low edges grow by ceil(t) and the high edges by floor(t).
 * Widths above the old maximum 3 draw as 3 here too, so direct callers match the import clamp. */
export function legacyOutlineExtent(settings) {
  if (!bool(settings.outline, 'outline')) return { low: 0, high: 0 };
  let t = Math.min(OLD_OUTLINE_MAX, finite(settings.outline_width ?? 1, 'Outline width', 0));
  if (t === 0 && settings.outline_width_rounded) t = .25;
  return { low: Math.ceil(t), high: Math.floor(t) };
}
/** Old outlines wider than 1 px on both sides (integer widths 2 and 3); the assumed full outline is 1 px. */
export const OUTLINE_REDUCED_NOTE = (width, px) => `Old outline thickness ${width} drew ${px} px; the new outline is 1 px.`;
/** 2000922 modes: 1 is one pixel all round (no capture), 2 is top and left only (one user capture, issue #11). */
export const nativeOutlineExtent = (settings, override) =>
  [{ low: 0, high: 0 }, { low: 1, high: 1 }, { low: 1, high: 0 }][effectiveOutlineMode(settings, override)];

/** Opt-in export choices; `'auto'` derives the mode from the old settings. Only the half outline has a capture. */
export const OUTLINE_CHOICES = Object.freeze(['auto', 0, 1, 2]);
/** Old styles 2 to 5 convert directly (old weapon_csbase.cpp L2002-2050): styles 2, 3 and 4 drew the style-4 gap at
 * rest (2 and 3 followed the weapon's spread, which the export assumes is none), style 5 its own (ADR-0018). */
export const STATIC_AT_REST_STYLES = Object.freeze([2, 3, 4, 5]);
/** Blocker for old styles 0 and 1: the default styles drew a different reticle, not the cvar bars. */
export const DEFAULT_STYLE_BLOCKER = 'Old styles 0 and 1 (the default styles) drew a different reticle, not bars from size, ' +
  'thickness and gap, so they cannot be converted. Add cl_crosshairstyle 4 to the paste to convert your size, thickness and gap.';
/** Blocker for any other old style (6, 7, 9, -1, 4.5…): the old game had only styles 0 to 5. */
export const UNKNOWN_STYLE_BLOCKER = style => `Old style ${style} is unknown to the old game, which had only styles 0 to 5, ` +
  'so it cannot be converted. Add cl_crosshairstyle 4 to the paste to convert your size, thickness and gap.';
/** The blocker for an old style outside 2..5, or null. */
export const styleBlocker = style => STATIC_AT_REST_STYLES.includes(style) ? null
  : style === 0 || style === 1 ? DEFAULT_STYLE_BLOCKER : UNKNOWN_STYLE_BLOCKER(style);
export const STYLE_TARGETS = Object.freeze(['static', 'family']);
/** Normalize the outline option: `'auto'` (also null/undefined and numeric strings) or 0, 1, 2. */
export function outlineChoice(value) {
  if (value === undefined || value === null || value === 'auto') return 'auto';
  const n = typeof value === 'string' && /^[012]$/.test(value) ? Number(value) : value;
  if (n !== 0 && n !== 1 && n !== 2) throw new Error('Outline mode must be auto, 0, 1 or 2.');
  return n;
}
export function styleTargetChoice(value) {
  if (value === undefined || value === null) return 'static';
  if (!STYLE_TARGETS.includes(value)) throw new Error('Style target must be static or family.');
  return value;
}
export const T_SHAPE_CHOICES = Object.freeze(['keep', 'auto', 'on', 'off']);
/** Normalize the T option (ADR-0025): `'keep'` (default, the old T flag), `'auto'` (ADR-0020's planned flip), `'on'` or `'off'`. */
export function tShapeChoice(value) {
  if (value === undefined || value === null) return 'keep';
  if (!T_SHAPE_CHOICES.includes(value)) throw new Error('T shape must be keep, auto, on or off.');
  return value;
}
/** Outline mode actually exported: the user's choice, else the one derived from the old settings. */
export const effectiveOutlineMode = (settings, override) => {
  const choice = outlineChoice(override);
  return choice === 'auto' ? outlineMode(settings) : choice;
};
/** New style to export. `'static'` (default) is always Static Cross 4. `'family'` keeps the old family:
 * old 2 and 3 become 2 (Dynamic Cross, Classic), old 5 becomes 5 (Dynamic Cross, Legacy/Shot Feedback),
 * everything else 4. Experimental: the old source drew styles 2/3 like style 4 at rest (style 5 with its own gap, ADR-0018),
 * but the new styles 2 and 5 move with inaccuracy and shots. */
export function styleTarget(settings, mode = 'static') {
  if (styleTargetChoice(mode) === 'static') return 4;
  return settings.style === 2 || settings.style === 3 ? 2 : settings.style === 5 ? 5 : 4;
}
/** `nativeCommands` overrides for a resolved scope (`outlineMode`, `styleTarget`, a forced T flag); defaults change nothing. */
export const exportOverrides = (settings, options = {}) => ({
  ...(outlineChoice(options.outlineMode) === 'auto' ? {} : { outlineMode: outlineChoice(options.outlineMode) }),
  ...(['on', 'off'].includes(tShapeChoice(options.tShape)) ? { t_style: tShapeChoice(options.tShape) === 'on' } : {}),
  style: styleTarget(settings, options.styleTarget) });
export const STYLE_FAMILY_NOTE = style => `Exported style ${style} keeps the old style family. Its at-rest shape is assumed ` +
  'to match Static Cross, but it moves with inaccuracy and shots, which is neither modelled nor checked in game.';
export const STYLE_DYNAMIC_NOTE = style => `Old style ${style} moved with movement or shots; the export is Static Cross, ` +
  'which does not move, at the gap with no weapon spread (old styles 2 and 3 may have drawn it about 1 px smaller with ' +
  "a rifle). Set Style to 'Old style family' to keep a moving style.";
/** Old style 5 (Legacy) placed its bars at `round(4 × height / 1200 + gap)` at rest (ADR-0018); `now` and `plain`
 * are the gap in old pixels under that rule and under Static Cross's `trunc(4 + gap)`. */
export const LEGACY_STYLE_5_NOTE = (height, now, plain) => 'Old style 5 (Legacy) placed its bars at round(4 × height / ' +
  `1200 + gap) at rest instead of Static Cross's trunc(4 + gap); at ${height} that is ${now} instead of ${plain} pixels, ` +
  'a reading of the old source that is unverified in the pre-update game.';
/** Warnings (`{ code, text }`) for the non-default export options; empty for the defaults. */
export function optionWarnings(settings, options = {}) {
  const out = [], mode = outlineChoice(options.outlineMode), style = styleTarget(settings, options.styleTarget);
  const tChoice = tShapeChoice(options.tShape);
  if (['on', 'off'].includes(tChoice) && (tChoice === 'on') !== Boolean(settings.t_style)) out.push({ code: 't-user-choice',
    text: `T shape set by hand: the export draws ${tChoice === 'on' ? 'a T (one arm below the centre)' : 'a full cross'}; ` +
      `the old crosshair ${settings.t_style ? 'was a T' : 'was a full cross'}.` });
  if (mode !== 'auto') out.push({ code: 'outline-user-override', text: `Outline mode chosen by hand: ${mode}.` });
  if (style !== 4) out.push({ code: 'style-family-experimental', text: STYLE_FAMILY_NOTE(style) });
  else if ([2, 3, 5].includes(settings.style)) out.push({ code: 'style-dynamic-at-rest', text: STYLE_DYNAMIC_NOTE(settings.style) });
  return out;
}

/** Fill alpha to export: the old opacity; for `cl_crosshairusealpha 0` 255. The old fill was additive, never
 * dimmed the background and looked near full colour; a normal blend at 200 looks dimmer than it ever did. */
export function exportFillAlpha(settings) {
  const { alpha } = rgba(settings);
  return settings.alpha_enabled ? alpha : 255;
}
export const ADDITIVE_NOTE = alpha => 'With cl_crosshairusealpha 0 the old colour was added to the scene at opacity 200 ' +
  'and never darkened it; the current game blends normally, where 200 looks dimmer, so the export uses opacity ' +
  `${alpha} for the colour and 200 for the outline.`;
export const OUTLINE_ONLY_NOTE = 'The old crosshair showed only outline strokes (size 0 with an outline); this export keeps ' +
  'length 0, which the current game draws as nothing, outline included (user capture, issue #11), and the automatic ' +
  'model redraws the strokes as black bars.';

/** Colour override `{ rgb: [r, g, b], alpha }`, validated like the old colour. */
function exportColor(color) {
  if (!Array.isArray(color?.rgb) || color.rgb.length !== 3) throw new Error('Export colour must be three RGB values.');
  color.rgb.forEach(v => integer(v, 'RGB', 0, 255)); integer(color.alpha, 'Alpha', 0, 255);
  return { rgb: [...color.rgb], alpha: color.alpha };
}
/** Optional export line groups: lines the old input may never have chosen, so a user can leave them to the game. */
export const EXPORT_GROUPS = Object.freeze({
  color: Object.freeze(['cl_crosshaircolor_r', 'cl_crosshaircolor_g', 'cl_crosshaircolor_b']),
  opacity: Object.freeze(['cl_crosshaircolor_a']),
  outline: Object.freeze(['cl_crosshair_drawoutline']),
  outlineColor: Object.freeze(['cl_crosshairoutline_r', 'cl_crosshairoutline_g', 'cl_crosshairoutline_b', 'cl_crosshairoutline_a']),
  recoil: Object.freeze(['cl_crosshair_recoil']),
  screenHeight: Object.freeze(['cl_crosshair_screen_height']),
});
/** Outline-only shapes need the replacement bars' RGB, opacity and outline override together. */
export const requiredExportGroups = (overrides = {}) => ({ color: overrides.color !== undefined,
  opacity: overrides.color !== undefined, outline: overrides.color !== undefined && overrides.outlineMode !== undefined });
/** Old setting keys that choose RGB, independently of fill opacity. */
const COLOR_KEYS = ['color', 'r', 'g', 'b'];
/** Default ticks per group: on only when the old input set what the group converts (`overrides` as exported, e.g.
 * `mergedExportOverrides(report)`, so a hand-chosen outline mode counts). `assigned` is the setting keys
 * the input assigned. The outline colour needs an exported outline; the height always applies (sizes scale with it). */
export function defaultExportGroups(assigned, settings, overrides = {}) {
  const set = new Set(assigned), any = keys => keys.some(key => set.has(key));
  // Required groups are applied by `nativeCommands`, not stored as ticks, so they lapse when the shape changes.
  return { color: any(COLOR_KEYS), opacity: any(['alpha', 'alpha_enabled']),
    outline: any(['outline', 'outline_width']) || (overrides.color === undefined && overrides.outlineMode !== undefined),
    outlineColor: any(['outline', 'outline_width']) && effectiveOutlineMode(settings, overrides.outlineMode) !== 0,
    recoil: set.has('recoil'), screenHeight: true };
}
/** `include` is null (every group) or `{ group: boolean }` for known group names only. */
function exportInclude(include) {
  if (include === null) return null;
  if (typeof include !== 'object' || Array.isArray(include)) throw new Error('Export groups must be an object of booleans.');
  for (const [key, value] of Object.entries(include)) {
    if (!Object.hasOwn(EXPORT_GROUPS, key)) throw new Error(`Unknown export group: ${key}.`);
    bool(value, `Export group ${key}`);
  }
  return include;
}
/** Single allowlisted formatting path shared by automatic and manual exports. `overrides.color` and
 * `overrides.t_style` replace the old colour and T flag (a report's `exportOverrides`). `include` null keeps every
 * line; otherwise the lines of groups set to false are dropped, except required groups. */
export function nativeCommands(settings, native, overrides = {}, include = null) {
  validateNative(native, NATIVE_RANGES_2000922);
  const mode = effectiveOutlineMode(settings, overrides.outlineMode);
  const style = overrides.style ?? 4;
  if (![2, 4, 5].includes(style)) throw new Error('Exported style must be 2, 4 or 5.');
  for (const key of ['dot', 't_style', 'outline', 'recoil']) bool(settings[key], key);
  const base = rgba(settings), {rgb, alpha} = overrides.color === undefined ? base : exportColor(overrides.color);
  const fill = overrides.color === undefined ? exportFillAlpha(settings) : alpha;
  const tStyle = bool(overrides.t_style ?? settings.t_style, 't_style');
  const choice = exportInclude(include), required = requiredExportGroups(overrides);
  const dropped = new Set(Object.entries(EXPORT_GROUPS).filter(([group]) => choice && choice[group] === false && !required[group])
    .flatMap(([, names]) => names));
  const lines = [`cl_crosshairstyle ${style}`, `cl_crosshair_length ${native.length}`, `cl_crosshair_thickness ${native.thickness}`,
    `cl_crosshair_gap ${native.gap}`,
    `cl_crosshairdot ${Number(settings.dot)}`, `cl_crosshair_t ${Number(tStyle)}`, `cl_crosshair_drawoutline ${mode}`,
    'cl_crosshairoutline_r 0', 'cl_crosshairoutline_g 0', 'cl_crosshairoutline_b 0',
    `cl_crosshairoutline_a ${mode ? alpha : 255}`,
    `cl_crosshair_recoil ${Number(settings.recoil)}`,
    ...rgb.map((v,i)=>`cl_crosshaircolor_${'rgb'[i]} ${v}`), `cl_crosshaircolor_a ${fill}`,
    '// Authored height last. Read it back in game; these commands do not change the game resolution.',
    `cl_crosshair_screen_height ${native.authoredHeight}`];
  return lines.filter(line => !dropped.has(line.split(' ')[0]));
}
