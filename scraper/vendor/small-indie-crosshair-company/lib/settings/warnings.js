import { outlineMode, outlineChoice, effectiveOutlineMode, outlineRounded, legacyOutlineExtent, colorIndexUnknown,
  COLOR_INDEX_NOTE, OUTLINE_REDUCED_NOTE, OUTLINE_ROUNDED_NOTE, exportFillAlpha, ADDITIVE_NOTE } from './native.js';

/** Warnings shared by the automatic solver reports and the manual lab (one wording, `{ code, text }` each). */
const warning = (code, text) => ({ code, text });

/** Warning for old outlines that drew unevenly (width above 1) but export as a full 1 px outline.
 * `override` is the export option `outlineMode`; the warning applies only when the exported mode is 1. */
export function outlineAsymmetryWarning(settings, override = 'auto') {
  const { low, high } = legacyOutlineExtent(settings);
  return low !== high && effectiveOutlineMode(settings, override) === 1
    ? warning('outline-asymmetric-approx', `Old outline thickness ${settings.outline_width} drew ${low} px on the top/left ` +
      `and ${high} px on the bottom/right; the new full outline is 1 px all round.`) : null;
}

/** Warning for old outlines that drew the same width above 1 on every side but export as a 1 px outline.
 * Unequal sides are covered by the asymmetric warning instead. */
export function outlineReducedWarning(settings, override = 'auto') {
  const { low, high } = legacyOutlineExtent(settings);
  return low === high && low > 1 && effectiveOutlineMode(settings, override) === 1
    ? warning('outline-width-reduced', OUTLINE_REDUCED_NOTE(settings.outline_width, low)) : null;
}

/** Every outline warning for (settings, options), shared by the community and historical reports so the same input
 * gets the same set. Mode-dependent notes follow the exported mode (`effectiveOutlineMode`), not the automatic one. */
export function outlineWarnings(settings, options = {}) {
  const automatic = outlineMode(settings), mode = effectiveOutlineMode(settings, options.outlineMode);
  const byHand = outlineChoice(options.outlineMode) !== 'auto';
  const out = [];
  if (settings.outline && automatic === 0 && !byHand)
    out.push(warning('outline-zero-width', 'Old outline thickness 0 drew no outline, so the export turns the outline off.'));
  // The rounded-zero note explains the automatic half outline, so it needs that export (not a hand choice or override).
  if (outlineRounded(settings) && mode === 2 && !byHand) out.push(warning('outline-sharecode-rounded', OUTLINE_ROUNDED_NOTE));
  if (mode === 2 && !byHand)
    out.push(warning('outline-half-mapping', 'An old outline thinner than 1 drew only on the top and left, so the ' +
      'export uses the half outline (cl_crosshair_drawoutline 2), which matches one user capture (issue #11).'));
  if (mode === 1) out.push(warning('outline-replacement-unverified',
    'The full outline (cl_crosshair_drawoutline 1) is modelled as 1 px all round; no game capture checks it yet.'));
  for (const entry of [outlineAsymmetryWarning(settings, options.outlineMode), outlineReducedWarning(settings, options.outlineMode)])
    if (entry) out.push(entry);
  return out;
}


/** Old settings the new game has no equivalent for, shared by both report paths: the additive
 * `cl_crosshairusealpha 0` fill (unless an override replaces the colour) and the per-weapon gap. */
export function legacySettingWarnings(settings, overrides = {}) {
  const out = [];
  if (!settings.alpha_enabled && overrides.color === undefined)
    out.push(warning('additive-blend-approximated', ADDITIVE_NOTE(exportFillAlpha(settings))));
  if (settings.weapon_gap) out.push(warning('weapon-gap-dropped', 'With cl_crosshairgap_useweaponvalue 1 the old gap ' +
    'changed per weapon; the current game has one gap, so the export uses the gap without the weapon value.'));
  return out;
}

/** Warning for share-code colour indexes 6 and 7, which convert with the stored RGB. */
export const colorIndexWarning = settings =>
  colorIndexUnknown(settings) ? warning('color-index-unknown', COLOR_INDEX_NOTE(settings.color)) : null;

