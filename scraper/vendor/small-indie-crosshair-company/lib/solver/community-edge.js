/** Old shapes the new renderer cannot draw literally: crossed arms (issue #15), outline-only size 0
 * (issue #11) and a dot at size 0. Plans the target the dimension search fits, and checks the result by colour. */
import { foldCrossedArms, outlineAsCore, dotAsArms, tShape } from '../geometry/edge-cases.js';
import { appearance, legacyAppearance, maskAppearance, compareAppearance, appearanceScorer } from '../geometry/appearance.js';
import { outlineOnly } from '../geometry/raster.js';
import { compileMask } from '../geometry/pixel-shape.js';
import { drawability, DRAWABILITY_BUILD } from '../geometry/drawability.js';
import { legacyOutlineExtent, nativeOutlineExtent, effectiveOutlineMode, rgba } from '../settings/native.js';

const warn = (code, text) => ({ code, text });

/**
 * The target the search fits and the visible old shape it is scored against, both in old pixels.
 * `reference` is the old visible mask as a core shape: the old geometry, or the outline strokes when size 0
 * drew only outlines. The rules apply to the legacy reconstruction only; measured targets and images stay literal.
 * `tShape` is the T-shape family of the literal `source` (ADR-0020; null without T or for literal targets).
 * @returns {{target: object, reference: object, cases: string[], fold: string, shift: number[], tShape: ?object}}
 */
export function edgeCaseTarget(source, settings, legacyInput) {
  // Bare geometry inputs (research sweeps) carry no outline flag.
  const extent = settings.outline === undefined ? { low: 0, high: 0 } : legacyOutlineExtent(settings), cases = [];
  let target = source, reference = source, shift = [0, 0];
  if (!legacyInput) return { target, reference, cases, fold: 'none', shift, tShape: null };
  if (source.length === 0 && source.width > 0) {
    if (settings.dot) {
      ({ target, shift } = dotAsArms(source));
      cases.push(extent.low + extent.high > 0 ? 'dot-only-outlined' : 'dot-only');
    } else if (outlineOnly(source, settings, extent)) {
      target = reference = outlineAsCore(source, extent).target;
      cases.push('outline-only');
    }
  }
  const folded = foldCrossedArms(target);
  if (folded.kind !== 'none') {
    target = folded.target; shift = folded.shift;
    cases.push(`crossed-${folded.kind}`);
  }
  return { target, reference, cases, fold: folded.kind, shift,
    tShape: tShape(source, settings, extent) };
}

/** Export overrides the plan needs: outline-only shapes are redrawn as bars in the old outline colour (black,
 * at the old crosshair opacity) with the outline off, unless the outline mode was chosen by hand. A changed T flag
 * (ADR-0020) is added by the caller from the solved flags. */
export function edgeCaseOverrides(settings, options, cases) {
  return cases.includes('outline-only') ? { color: { rgb: [0, 0, 0], alpha: rgba(settings).alpha },
    ...(options.outlineMode === 'auto' ? { outlineMode: 0 } : {}) } : {};
}

/** What the old T stem did, per T-shape family (ADR-0020), as the opening sentence of the T warnings. */
const T_STEM = {
  inverted: () => 'The old T\'s single vertical arm sat above the horizontal bar, an upside-down T.',
  'straddle-symmetric': () => 'The old T\'s single vertical arm ran through the horizontal bar, equally far above ' +
    'and below it, so the old T looked like a full cross.',
  straddle: ({ above, below }) => `The old T's single vertical arm ran through the horizontal bar, ${above} px above ` +
    `and ${below} px below it, which a T cannot draw.`,
  'stem-hidden': () => 'The old T\'s single vertical arm lay inside the horizontal bar, so the old shape showed ' +
    'no T.',
  strokes: () => 'The old outline strokes crossed the centre, which put the single vertical stroke of the T on the ' +
    'other side.',
};
const tStemText = tShape => (T_STEM[tShape?.family] ?? (() => 'The old T drew its single vertical arm where a T ' +
  'cannot draw it now.'))(tShape ?? {});

/** Warning when the export draws a full cross for an old T (`tShape` the plan's T shape, ADR-0020). */
export function tFlipWarning(tShape) {
  const why = { inverted: ' The current game draws a T\'s arm below the centre, so the export draws a full cross, ' +
    'whose top arm reproduces the old arm; the extra bottom arm is the difference.',
  'straddle-symmetric': ' The export draws a full cross.' }[tShape?.family] ?? ' A full cross matches more of the old ' +
    'pixels, so the export draws one.';
  return warn('t-flipped-for-shape', tStemText(tShape) + why);
}

/** Warnings for the planned edge cases (`plan` from `edgeCaseTarget`, `status` the shape-check status: a kept T that
 * still matches needs no warning; `outlineMode` the exported outline mode, 0 unless chosen by hand for an
 * outline-only shape). `settings.t_style` is the exported T flag. */
export function edgeCaseWarnings(settings, plan, status = 'approximate', outlineMode = 0) {
  const out = [], has = code => plan.cases.includes(code);
  if (plan.fold !== 'none') out.push(warn('crossed-arms-folded', plan.fold === 'full'
    ? 'The negative gap made the old arms cross the centre, so each arm was drawn on the opposite side. ' +
      'The conversion accounts for that crossing using a non-negative gap.'
    : 'The negative gap made the old arms cross the centre and merge into one solid bar per axis. ' +
      'The conversion accounts for that overlap using gap 0; visible outline overpaint is scored separately.'));
  // ADR-0020: only a stem above the bar (or crossed strokes) is lost when T is kept.
  const shape = plan.tShape, lostStem = shape?.flippable && (shape.family === 'strokes' ? shape.crossed : shape.family !== 'stem-hidden');
  if (settings.t_style && lostStem && status === 'approximate') out.push(warn('inverted-t-unrepresentable',
    tStemText(plan.tShape) + ({ inverted: ' The export keeps T, and the current game draws a T\'s arm below the ' +
      'centre, so it appears on the other side.', strokes: ' The export keeps T, and the current game draws that ' +
      'stroke below the centre.' }[plan.tShape.family] ?? ' The export keeps T, so only the part below the bar is drawn.')));
  if (has('outline-only')) out.push(warn('outline-only-as-core',
    'The old crosshair showed only outline strokes (size 0 with an outline) and the current game draws nothing for ' +
    'length 0, so the export draws those strokes as bars in the old outline colour ' +
    `(black, opacity ${rgba(settings).alpha}) ` + (outlineMode ? `with the hand-chosen outline mode ${outlineMode}, ` +
      'which adds a black outline around them.' : 'with the outline off.')));
  if (has('dot-only') || has('dot-only-outlined')) out.push(warn('dot-only-as-arms',
    'Size 0 drew only the dot and the current game may draw nothing for length 0, so the export adds arms at gap 0 ' +
    'that cover exactly the dot square; the dot stays on.'));
  if (has('dot-only-outlined') && status === 'approximate') out.push(warn('zero-length-outline-dropped',
    'The old zero-length bars drew outline strokes around the gap, which the current game cannot draw, so the export ' +
    'is the closest shape found within the search window: short arms whose outline covers part of those strokes.'));
  return out;
}

const key = ({ rgb, alpha }) => `${rgb.join(',')},${alpha}`;
const oldColors = settings => {
  const old = rgba(settings);
  return { core: key(old), outline: key({ rgb: [0, 0, 0], alpha: old.alpha }) };
};

/** True when the old draw order left outline pixels over an earlier bar or dot fill: the old look
 * differs from the same rectangles with every outline beneath every fill, which is all the new game can draw. */
export function outlineOverpaint(settings, target) {
  const extent = legacyOutlineExtent(settings);
  if (extent.low + extent.high <= 0) return false;
  const colors = oldColors(settings);
  return compareAppearance(legacyAppearance(target, settings, extent, colors),
    appearance(target, settings, extent, colors, true)).different > 0;
}

/** Warning when overpainted outline pixels exist and the export, after the appearance refinement, still
 * does not reproduce the old look within a whole-shape shift of 1 px. */
export const overpaintWarning = (settings, target, status) => outlineOverpaint(settings, target) && status === 'approximate'
  ? warn('outline-overpaint-lost', 'The old game drew each outline just before its own bar or dot, so a later outline ' +
    'darkened part of an earlier bar or the dot; the current game draws all colour over all outline, so some of those ' +
    'dark pixels differ in the closest shape found within the search window.') : null;
/** What the export draws: core in the exported colour, outline (black) by the exported mode, colour over outline. */
export function exportedAppearance({ settings, flags = settings, converted, overrides, options }) {
  const old = rgba(settings), mode = effectiveOutlineMode(settings, overrides.outlineMode ?? options.outlineMode);
  const core = overrides.color ?? old;
  return appearance(converted, flags, nativeOutlineExtent(settings, mode),
    { core: key(core), outline: oldColors(settings).outline }, false)
    .filter((_, index) => (index === 0 ? old.alpha : core.alpha) > 0);
}
/** The old visible appearance `shapeCheck` compares against: legacy outline extent, old draw order. The extent
 * stays in fixed pixels when a screen goal scales the target, as both games draw outlines in whole pixels. */
export const oldAppearance = (settings, target) =>
  rgba(settings).alpha === 0 ? [] : legacyAppearance(target, settings, legacyOutlineExtent(settings), oldColors(settings));
/** Proof that no export draws the old look under the build 2000922 model (ADR-0028); `impossible: false` means
 * no proof was found, not that an exact tuple exists. */
export const oldDrawability = (settings, target) =>
  ({ ...drawability(oldAppearance(settings, target), key(rgba(settings))), build: DRAWABILITY_BUILD });
const UNDRAWABLE = {
  'outline-reach': 'its dark outline pixels reach more than 1 px beyond the coloured pixels or cover them, but the ' +
    'current outline is at most 1 px wide (cl_crosshair_drawoutline 0, 1 or 2; there is no outline-width setting) and ' +
    'is always drawn beneath the colour',
  'not-mirror-symmetric': 'its visible shape is not the same mirrored left to right, but every current crosshair is ' +
    '(equal left and right arms, a centred dot; T only hides the top arm)',
};
export const undrawableWarning = ({ reasons, build }) => warn('old-shape-not-drawable',
  `No setting of the current game draws this old crosshair exactly (build ${build.model}; the crosshair settings are ` +
  `unchanged in ${build.cvarsUnchanged.join(', ')}): ${reasons.map(reason => UNDRAWABLE[reason]).join('; and ')}. ` +
  'The export is the closest drawable shape found. This follows from the renderer model, not an in-game capture.');
/** True when the export draws at least one pixel (core or outline), same arguments as `shapeCheck`. */
export const exportDraws = args => exportedAppearance(args).some(layer => layer.boxes.length > 0);
/**
 * Old against new visible appearance by colour: old core in the crosshair colour and old outline (black, at the
 * crosshair opacity) with the legacy outline extent, painted in the old draw order; new core in the exported
 * colour and outline by the exported mode, colour over outline. Aligned = best whole-shape shift of at most one pixel.
 * @returns {{status: ('exact'|'shifted'|'approximate'|'empty'), iou: ?number, alignedIou: ?number, scope: string}}
 */
export function shapeCheck({ settings, flags = settings, target, converted, overrides, options, targetMask }) {
  const before = targetMask ? maskAppearance(compileMask(targetMask), key(rgba(settings))) : oldAppearance(settings, target);
  const after = exportedAppearance({ settings, flags, converted, overrides, options });
  const { iou, aligned: alignedIou } = appearanceScorer(before)(after);
  const status = iou === null ? 'empty' : iou === 1 ? 'exact' : alignedIou === 1 ? 'shifted' : 'approximate';
  return { status, iou, alignedIou, scope: targetMask
    ? 'Image target: the measured core against the new core and outline, by colour. Illustrative pixels, not a capture.'
    : 'Old core and outline (old draw order) against the new core and outline, by colour, under the declared models; ' +
      'zero-length bars keep their outline only in the old game. A screen goal scales the old core to the new screen ' +
      'and keeps the old outline in whole pixels, as both games draw it. Illustrative pixels, not a capture.' };
}
