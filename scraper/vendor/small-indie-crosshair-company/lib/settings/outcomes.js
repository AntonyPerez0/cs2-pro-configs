import { outlineMode, outlineRounded, effectiveOutlineMode, styleTarget, exportFillAlpha,
  exportOverrides, requiredExportGroups, rgba } from './native.js';
import { DEFAULTS_NOTE_PREFIX } from './cfg.js';

/**
 * What happened to each legacy setting, for display next to the converted values. Pure: it reads the
 * settings, the solver report and the importer notes and never recomputes a conversion.
 *
 * status: `converted` exact under the model; `approximated` rounded, clamped or shifted by the model;
 * `assumed` mapping not checked in game; `user-choice` set by hand in the export options;
 * `dropped` no new equivalent; `ignored` does not shape the crosshair.
 */
export const STATUSES = Object.freeze(['converted', 'approximated', 'assumed', 'user-choice', 'dropped', 'ignored']);

const num = value => Number.isInteger(value) ? String(value) : Number(Number(value).toFixed(4)).toString();
/** Pixel values in reasons: at most two decimals. */
const px = value => Number.isFinite(value) ? Number(value.toFixed(2)).toString() : String(value);
/** Pixel sizes are equal when they differ by float noise only. */
const differs = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) > 1e-6 : a !== b;
const codesOf = report => new Set((report?.warnings ?? []).map(w => w?.code).filter(Boolean));

/** `label value` pairs from the importer's "Not in the paste, game defaults used: …" note. */
export function defaultedCvars(importNotes = []) {
  const note = importNotes.map(String).find(text => text.startsWith(DEFAULTS_NOTE_PREFIX));
  return note ? note.slice(DEFAULTS_NOTE_PREFIX.length).replace(/\.$/, '').split(', ') : [];
}

/** Warning for a partial paste (code `defaults-filled`): the cvars filled from the pre-update game defaults, or null
 * for share codes and complete pastes, which leave no defaults note. */
export function defaultsWarning(importNotes = []) {
  const filled = defaultedCvars(importNotes);
  return filled.length ? { code: 'defaults-filled', text: 'Added from the old game\'s defaults because your paste did ' +
    `not set them: ${filled.join(', ')}.` } : null;
}
/** "What changed" row of each defaults-note label (cfg.js DEFAULT_LABELS). The alpha and colour rows depend on
 * several labels, so `addedRow` decides them from what their Old column shows. */
const DEFAULT_ROWS = { size: 'cl_crosshairsize', thickness: 'cl_crosshairthickness', gap: 'cl_crosshairgap',
  style: 'cl_crosshairstyle', dot: 'cl_crosshairdot', T: 'cl_crosshair_t', outline: 'cl_crosshair_drawoutline',
  'outline thickness': 'cl_crosshair_outlinethickness', recoil: 'cl_crosshair_recoil',
  useweaponvalue: 'cl_crosshairgap_useweaponvalue' };
export const ADDED_DEFAULT = 'added (game default)';

/** Cvar names listed by the importer's "Ignored N cvar(s) ...: a, b." note. */
export function ignoredCvars(importNotes = []) {
  return importNotes.flatMap(note => {
    const match = /^Ignored \d+ cvar\(s\)[^:]*: (.*)\.$/.exec(String(note));
    return match ? match[1].split(', ') : [];
  });
}

/** Reasons for values the edge-case rules change on purpose, by warning code. */
const EDGE_REASONS = [
  ['outline-only-as-core', {
    length: v => `Old size 0 showed only outline strokes; length ${v} redraws them as bars (length 0 draws nothing now).`,
    thickness: () => 'Old thickness plus the outline strokes on both sides.',
    gap: () => 'Places the bars where the old outline strokes were.' }],
  ['dot-only-as-arms', {
    length: v => `Old size 0 showed only the dot; length ${v} adds arms that stay inside the dot square.` }],
  ['crossed-arms-folded', {
    gap: v => `The old arms crossed the centre; gap ${v} accounts for that crossing without a negative gap.` }],
];

/** Which of length, thickness and gap the model could not keep, with a plain reason each. */
function dimensionOutcomes(report) {
  const codes = codesOf(report), t = report?.target, c = report?.converted, n = report?.chosen?.native ?? {};
  const edges = report?.rendering;
  const refined = codes.has('appearance-refined'), limit = refined || codes.has('dimension-limit');
  // ADR-0026: a refinement that preserved a visible dot says so, and whether total overlap paid for it.
  const aimed = Boolean(report?.aimingShape?.prioritized), tradeoff = Boolean(report?.decision?.refinement?.appearanceTradeoff);
  // Clamped values are recorded by every path; the warning codes alone only cover the community path.
  const clamp = {};
  for (const entry of report?.clamped ?? []) clamp[entry.field] ??= entry;
  // Only a visible difference blames a row; pure rounding of a fractional ideal that lands on the same pixels does not.
  const off = {
    length: Boolean(limit && t && c && differs(c.length, t.length)),
    thickness: Boolean(limit && t && c && differs(c.width, t.width)),
    gap: Boolean(limit && edges && differs(edges.convertedEdges?.near, edges.targetEdges?.near)),
  };
  // Several edge-case rules can apply to one shape (e.g. outline-only strokes that also cross the centre).
  const edgeReasons = EDGE_REASONS.filter(([code]) => codes.has(code)).map(([, reasons]) => reasons);
  const shifted = report?.shapeCheck?.status === 'shifted' || codes.has('pixel-centering-shift');
  const te = edges?.targetEdges, ce = edges?.convertedEdges;
  const row = (key, value, wanted, got) => {
    const reasons = edgeReasons.map(reasons => reasons[key]?.(value)).filter(Boolean);
    if (reasons.length && !clamp[key] && !off[key]) return { status: 'converted', reason: reasons.join(' ') };
    if (key === 'thickness' && codes.has('visible-minimum'))
      return { status: 'approximated', reason: 'Old thickness 0 still drew a thin line, so a positive value is used.' };
    if (key === 'gap' && codes.has('negative-gap-static-unverified'))
      return { status: 'approximated', reason: 'Negative gap clamped to 0; Static Cross with a negative gap is not verified.' };
    if (clamp[key]) return { status: 'approximated',
      reason: `Old drew ${px(wanted)} px; the ideal ${px(clamp[key].wanted)} is outside the limits, so ${clamp[key].exported} is used.` };
    if (off[key]) return { status: 'approximated', reason: refined
      ? `Old drew ${px(wanted)} px; ${px(got)} px ${aimed ? 'keeps the old visible dot' +
        (tradeoff ? ', at the cost of some outline pixels.' : ' better.') : 'draws the old visible pixels better.'}`
      : `Old drew ${px(wanted)} px; integer steps and limits give ${px(got)} px.` };
    // The shape check reads "exact after a 1 px shift"; a gap whose inner or outer edge moved says so too.
    if (key === 'gap' && shifted && (differs(ce?.near, te?.near) || differs(ce?.far, te?.far)))
      return { status: 'approximated', reason: `Old inner bar edges ${px(te.near)} px (left/top) and ${px(te.far)} px ` +
        `(right/bottom) from the centre, new ${px(ce.near)} and ${px(ce.far)} px: the same shape one pixel over.` };
    if (key === 'thickness' && codes.has('pixel-centering-shift'))
      return { status: 'approximated', reason: 'Odd width: old and new pixel centres differ, so the bar may shift by one pixel.' };
    return { status: 'converted', reason: 'Matches the old pixel size under the model.' };
  };
  return {
    length: row('length', n.length, t?.length, c?.length),
    thickness: row('thickness', n.thickness, t?.width, c?.width),
    gap: row('gap', n.gap, edges?.targetEdges?.near, edges?.convertedEdges?.near),
  };
}

/** Evidence per exported outline mode: one user capture for the half outline, none for the full one. */
const MODE_EVIDENCE = ['No outline is exported.', 'The full outline (mode 1) is not checked in game.',
  'The half outline (mode 2) matches one user capture of the current game (issue #11).'];

/** Exported mode: a report's `exportOverrides` (outline-only shapes turn the outline off) beats the option. */
const exportedMode = (s, report) => report?.exportOverrides?.outlineMode ?? effectiveOutlineMode(s, report?.options?.outlineMode ?? 'auto');

/** Alpha and colour rows show a value several labels shape: marked only when the shown part was not in the paste. */
function addedRow(cvar, s, labels) {
  if (cvar === 'cl_crosshairalpha') return s.alpha_enabled ? labels.has('alpha') : labels.has('usealpha');
  if (cvar !== 'cl_crosshaircolor') return false;
  return s.color === 5 ? labels.has('rgb') : s.color > 5 ? labels.has('rgb') || labels.has('colour') : labels.has('colour');
}

/** Old T stem per T-shape family (ADR-0020), for the cl_crosshair_t row. */
const T_STEM_REASON = { inverted: 'The old single vertical arm sat above the bar, an upside-down T',
  'straddle-symmetric': 'The old single vertical arm ran through the bar equally far both ways, like a full cross',
  straddle: 'The old single vertical arm ran through the bar, which a T cannot draw',
  'stem-hidden': 'The old single vertical arm lay inside the bar, so the old shape showed no T',
  strokes: 'The old crossed outline strokes put the single vertical stroke on the other side',
  other: 'The old single vertical arm sat where a T cannot draw it' };

const labelsOf = importNotes => new Set(defaultedCvars(importNotes).map(entry => entry.replace(/ \S+$/, '')));

/** Result text of a row whose export group was unticked, and the rows (by cvar) each group covers. */
export const LEFT_OUT = 'left out (your current game value stays)';
const GROUP_ROWS = { color: ['cl_crosshaircolor'], opacity: ['cl_crosshairalpha'], recoil: ['cl_crosshair_recoil'],
  outline: ['cl_crosshair_drawoutline', 'cl_crosshair_outlinethickness'],
  outlineColor: ['outline colour', 'outline opacity'], screenHeight: ['cl_crosshair_screen_height'] };

/** `include` is the export selection (`nativeCommands`): rows of groups it leaves out say so (status user-choice). */
export function settingOutcomes(settings, report, importNotes = [], include = null) {
  const s = settings, n = report?.chosen?.native ?? {}, codes = codesOf(report), dims = dimensionOutcomes(report);
  const overrides = report?.exportOverrides ?? {};
  const rows = [];
  const required = requiredExportGroups({ ...exportOverrides(s, report?.options), ...overrides });
  const kept = group => !(include?.[group] === false && !required[group]);
  const add = (cvar, old, result, status, reason) => rows.push({ cvar, old, result, status, reason });
  add('cl_crosshairsize', num(s.size), `length ${n.length}`, dims.length.status, dims.length.reason);
  add('cl_crosshairthickness', num(s.thickness), `thickness ${n.thickness}`, dims.thickness.status, dims.thickness.reason);
  add('cl_crosshairgap', num(s.gap), `gap ${n.gap}`, dims.gap.status, dims.gap.reason);
  const family = report?.options?.styleTarget ?? 'static', style = styleTarget(s, family);
  if (style !== 4) add('cl_crosshairstyle', String(s.style), `style ${style}`, 'assumed',
    'Experimental: kept in the old style family, which moves with inaccuracy and shots; not checked in game.');
  else if ([2, 3, 5].includes(s.style)) add('cl_crosshairstyle', String(s.style), 'style 4', 'approximated',
    `Old style ${s.style} moved with movement or shots; Static Cross matches its at-rest shape (old source${s.style === 5
      ? ', gap rule of old style 5 applied' : ''}) but does not move.`);
  else add('cl_crosshairstyle', String(s.style), s.style === 4 ? 'style 4' : 'none', s.style === 4 ? 'converted' : 'dropped',
    s.style === 4 ? 'Copied as is.' : [0, 1].includes(s.style)
      ? 'Old styles 0 and 1 have no static equivalent.' : `Old style ${s.style} is unknown to the old game (styles 0 to 5).`);
  add('cl_crosshairdot', s.dot ? 'on' : 'off', s.dot ? 'on' : 'off', 'converted', 'Copied as is.');
  // ADR-0020: the reason follows the T-shape family of the old stem.
  const tFamily = report?.edgeCase?.tShape?.family, stem = T_STEM_REASON[tFamily] ?? T_STEM_REASON.other;
  const tChoice = report?.options?.tShape ?? 'keep';
  if (['on', 'off'].includes(tChoice) && (tChoice === 'on') !== Boolean(s.t_style))
    add('cl_crosshair_t', s.t_style ? 'on' : 'off', tChoice, 'user-choice',
      `Chosen by hand; the old crosshair was ${s.t_style ? 'a T' : 'a full cross'}.`);
  else if (s.t_style && codes.has('t-flipped-for-shape'))
    add('cl_crosshair_t', 'on', 'off', 'approximated', `${stem}; ${tFamily === 'inverted'
      ? 'the export draws a full cross, whose top arm reproduces it.' : 'the export draws a full cross.'}`);
  else if (s.t_style && codes.has('inverted-t-unrepresentable'))
    add('cl_crosshair_t', 'on', 'on', 'approximated', `${stem}; ${['inverted', 'strokes'].includes(tFamily)
      ? 'T is kept, so it is drawn below.' : 'T is kept, so only the part below the bar is drawn.'}`);
  else add('cl_crosshair_t', s.t_style ? 'on' : 'off', s.t_style ? 'on' : 'off', 'converted', 'Copied as is.');
  const auto = outlineMode(s), choice = report?.options?.outlineMode ?? 'auto';
  const mode = exportedMode(s, report), byHand = choice !== 'auto';
  if (overrides.outlineMode === 0 && s.outline) {
    add('cl_crosshair_drawoutline', 'on', 'drawoutline 0', 'approximated',
      'The old strokes are drawn as black bars instead, so the new outline is off.');
    add('cl_crosshair_outlinethickness', num(s.outline_width ?? 1), 'in the bars', 'approximated',
      'The old stroke width is part of the new length and thickness.');
  } else if (byHand) add('cl_crosshair_drawoutline', s.outline ? 'on' : 'off', `drawoutline ${mode}`, 'user-choice',
    `Chosen by hand; the old settings alone would give ${auto}. ${MODE_EVIDENCE[mode]}`);
  else if (!s.outline) add('cl_crosshair_drawoutline', 'off', 'drawoutline 0', 'converted', 'No outline before, none now.');
  else if (mode === 0) add('cl_crosshair_drawoutline', 'on', 'drawoutline 0', 'approximated', 'Old width 0 drew no outline; turned off.');
  else add('cl_crosshair_drawoutline', 'on', `drawoutline ${mode}`, 'assumed', MODE_EVIDENCE[mode]);
  if (overrides.outlineMode !== 0 && (s.outline || (byHand && mode))) {
    const width = num(s.outline_width ?? 1) + (outlineRounded(s) ? ' (rounded)' : '');
    const exact = mode === 1 && s.outline_width === 1;
    add('cl_crosshair_outlinethickness', s.outline ? width : 'off', mode ? `mode ${mode}` : 'none',
      byHand ? 'user-choice' : exact ? 'assumed' : 'approximated',
      byHand ? 'The outline mode was chosen by hand; the old width is not used.'
        : mode === 2 ? 'Widths below 1 become the half outline (top and left).'
        : mode === 1 && codes.has('outline-width-reduced')
          ? `Old width ${width} drew ${width} px on every side; the new outline is 1 px.`
        : mode === 1 ? 'The new outline is 1 px all round; the old width is not kept.' : 'No outline is drawn.');
    if (mode && (s.alpha_enabled ? s.alpha : 200) < 255 && kept('outlineColor'))
      add('outline opacity', 'crosshair opacity', `outline_a ${s.alpha_enabled ? s.alpha : 200}`, 'converted',
        'The old outline used the crosshair opacity; the current game sets it separately (user capture).');
  }
  if (mode && overrides.outlineMode !== 0) {
    const a = overrides.color?.alpha ?? rgba(s).alpha;
    add('outline colour', 'black at the crosshair opacity', kept('outlineColor') ? `outline 0 0 0 a${a}` : LEFT_OUT,
      kept('outlineColor') ? 'converted' : 'user-choice', kept('outlineColor')
        ? 'The old outline was always black at the crosshair opacity.'
        : `The old outline was black at opacity ${a}; tick Outline colour to set it.`);
  }
  if (overrides.color)
    add('cl_crosshaircolor', s.color === 5 ? `rgb ${s.rgb.join(' ')}` : `preset ${s.color}`,
      `colour ${overrides.color.rgb.join(' ')}`, 'approximated',
      'Only the black outline strokes were visible, so the bars that redraw them use the outline colour.');
  else if (codes.has('color-index-unknown'))
    add('cl_crosshaircolor', `index ${s.color}, rgb ${s.rgb.join(' ')}`, 'colour r, g, b', 'approximated',
      `Index ${s.color} is not a game preset; ${labelsOf(importNotes).has('rgb')
        ? 'the game-default RGB, which the paste did not set,' : 'the stored RGB'} is used.`);
  else add('cl_crosshaircolor', s.color === 5 ? `rgb ${s.rgb.join(' ')}` : `preset ${s.color}`, 'colour r, g, b', 'converted',
    'Copied as RGB.');
  if (s.alpha_enabled || overrides.color) add('cl_crosshairalpha', s.alpha_enabled ? String(s.alpha) : 'off (200)',
    `a ${overrides.color?.alpha ?? s.alpha}`, 'converted', 'Copied as is.');
  else add('cl_crosshairalpha', 'off (additive, 200)', `a ${exportFillAlpha(s)}`, 'approximated',
    'The old colour was added to the scene at 200 and never dimmed the background; the current game blends normally, ' +
    'so full opacity is used.');
  add('cl_crosshair_recoil', s.recoil ? 'on' : 'off', s.recoil ? 'on' : 'off', s.recoil ? 'assumed' : 'converted',
    s.recoil ? 'Copied, but recoil movement is not simulated.' : 'Static crosshair.');
  if (s.weapon_gap) add('cl_crosshairgap_useweaponvalue', 'on', 'none', 'dropped',
    'The old gap changed per weapon; the current game has one gap, so the gap without the weapon value is used.');
  add('cl_fixedcrosshairgap, split values', `gap ${num(s.fixed_gap)}`, 'none', 'dropped',
    'Only dynamic styles use them; the static crosshair does not.');
  if (!kept('screenHeight')) add('cl_crosshair_screen_height', 'authored height', LEFT_OUT, 'user-choice',
    'The game keeps its own screen height, so the sizes may scale differently.');
  for (const [group, cvars] of Object.entries(GROUP_ROWS)) if (!kept(group))
    for (const row of rows) if (cvars.includes(row.cvar) && row.result !== LEFT_OUT)
      Object.assign(row, { result: LEFT_OUT, status: 'user-choice', reason: 'Left out of the commands; your current game ' +
        'value stays and is unknown here, so the preview assumes the shown one.' });
  const defaulted = defaultedCvars(importNotes);
  // Rows whose old value the paste did not set say so in the Old column.
  const labels = labelsOf(importNotes);
  const added = new Set([...labels].map(label => DEFAULT_ROWS[label]));
  for (const row of rows) if (added.has(row.cvar) || addedRow(row.cvar, s, labels))
    { row.old = `${row.old} · ${ADDED_DEFAULT}`; row.added = true; }
  if (defaulted.length) add(`${defaulted.length} cvars not in the paste`, 'game defaults', 'see above', 'assumed',
    `Pre-update game defaults (build 2000908) were used: ${defaulted.join(', ')}.`);
  const ignored = ignoredCvars(importNotes);
  if (ignored.length) add(`${ignored.length} other cvars`, 'listed', 'none', 'ignored', `Do not change the shape: ${ignored.join(', ')}.`);
  return rows;
}

/** Wording per label: exact-under-model matches the model's own target; modelled was rounded, clamped or
 * shifted by the model; assumed rests on a mapping nobody has checked in game. */
export const CONFIDENCE_LABELS = Object.freeze({ 'exact-under-model': 'exact under model', modelled: 'modelled', assumed: 'assumed' });

/** Per output value: assumed when the mapping itself is unverified (negative gap, any outline), modelled when
 * the model had to approximate it, exact-under-model otherwise. */
export function confidenceLabel(report) {
  const codes = codesOf(report), dims = dimensionOutcomes(report);
  const label = (key, assumedWhen) => assumedWhen ? 'assumed' : dims[key].status === 'converted' ? 'exact-under-model' : 'modelled';
  // An export without an outline (mode 0) assumes nothing about the new outline.
  const outlined = exportedMode(report.settings, report) > 0;
  return { length: label('length', false), thickness: label('thickness', false),
    gap: label('gap', codes.has('negative-gap-static-unverified')), outline: outlined ? 'assumed' : 'exact-under-model' };
}
