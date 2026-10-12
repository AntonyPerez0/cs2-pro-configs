import { VERSION, BUILD, MODELS, forward, naiveAssignment } from './renderer.js';
import { localSupport } from './corpus.js';
import { proposeExperiment } from './experiments.js';
import { exactPreimage } from './inverse.js';
import { RASTER_CONVENTION, drawingEdges, outlineOnly } from '../geometry/raster.js';
import { COMMUNITY_MODEL } from '../geometry/community.js';
import { shapeCheck } from './community-edge.js';
import { NATIVE_RANGES, NATIVE_RANGES_2000922, outlineChoice, effectiveOutlineMode, legacyOutlineExtent,
  optionWarnings, OUTLINE_ONLY_NOTE } from '../settings/native.js';
import { outlineAsymmetryWarning, outlineReducedWarning, outlineWarnings, legacySettingWarnings,
  colorIndexWarning } from '../settings/warnings.js';
// Shared warning builders live in settings/ so the manual lab uses the same wording; re-exported for the solver.
export { outlineAsymmetryWarning, outlineReducedWarning, outlineWarnings, legacySettingWarnings, colorIndexWarning };

const warning = (code, text) => ({ code, text });

const ideal6 = value => Number(value.toFixed(6));
/** Warning when the outline mode chosen by hand cannot draw: the export has length 0 and no dot, and the current game
 * draws no outline around zero-length bars. */
export function outlineChoiceMootWarning(settings, options, length) {
  const choice = outlineChoice(options.outlineMode);
  return choice !== 'auto' && choice !== 0 && length === 0 && !settings.dot
    ? warning('outline-choice-moot', `Outline mode ${choice} was chosen by hand, but the export has length 0 and no dot, ` +
      'so the current game draws no bars and no outline for it.') : null;
}

/** Output dimensions clamped or approximated away from the ideal. `ideals` is `{ length, thickness, gap }`
 * in native units; `native` holds the exported values. Plain rounding to the nearest step is not listed.
 * `ranges` is the target build's native range (historical models target build 2000914, thickness 0..31);
 * `outlineMode` is the export override, so an outline entry states the mode actually exported. */
export function clampedOutputs(settings, ideals, native, { ranges = NATIVE_RANGES_2000922, outlineMode: override = 'auto' } = {}) {
  const out = [], RANGES = ranges;
  const add = (field, wanted, exported, reason) => out.push({ field, wanted: ideal6(wanted), exported, reason });
  for (const field of ['length', 'thickness', 'gap']) {
    const wanted = ideals[field], { max } = RANGES[field];
    if (!Number.isFinite(wanted)) continue;
    if (wanted > max) add(field, wanted, native[field], 'above-maximum');
    else if (field === 'gap' && wanted < 0) add(field, wanted, native[field], 'negative-gap-clamped-to-zero');
    else if (field !== 'gap' && wanted < 0) add(field, wanted, native[field], 'below-minimum');
  }
  if (settings.thickness === 0 && native.thickness !== 0) add('thickness', 0, native.thickness, 'visible-minimum');
  const exportedMode = effectiveOutlineMode(settings, override);
  if (outlineAsymmetryWarning(settings, override)) add('outline', settings.outline_width, exportedMode, 'outline-asymmetric-approx');
  if (outlineReducedWarning(settings, override)) add('outline', settings.outline_width, exportedMode, 'outline-width-reduced');
  return out;
}

/** Warnings are data (`{ code, text }`), not bare strings. `text` stays human-readable. */
function warningsFor(settings, state, visual, target, chosenNative, hasMask, options) {
  // Length 0 draws nothing in the current game, outline included; only a dot would remain.
  const draws = chosenNative.length > 0 || Boolean(settings.dot);
  const strokesOnly = !hasMask && outlineOnly(target, settings, legacyOutlineExtent(settings));
  const warnings = [
    warning('conditional-renderer-simulation', 'The new previews are simulations under the selected model, not game captures.'),
    warning('direct-copy-not-migration', 'Copied values are truncated or clamped; they do not reproduce Valve’s migration code.'),
    warning('shape-loss-excludes-appearance', 'Shape loss excludes color, alpha, outlines and recoil motion.'),
  ];
  const colorWarning = colorIndexWarning(settings);
  const conditions = [
    [settings.recoil, warning('recoil-motion-not-modeled', 'Follow recoil is exported; its motion is not simulated.')],
    [state.allModelConflict, warning('model-conflict',
      'Every model conflicts with the supplied game captures, so the highest-weighted one is not reliable.')],
    [!state.calibrationGroups, warning('no-native-calibration',
      'No game captures calibrate the new renderer, so the model weights are priors only.')],
    [visual.targetMask.cropped, warning('target-cropped', 'The measured target is cropped, so an exact image match cannot be claimed.')],
    [visual.previewCropped && !hasMask, warning('preview-cropped', 'The preview crops this large shape; the fit still uses all of it.')],
    [hasMask, warning('image-mask-noisy', 'The image mask is noisy and fits more than one set of old values.')],
    [visual.targetArea === 0 && (strokesOnly || !draws), strokesOnly
        ? warning('outline-only-legacy', OUTLINE_ONLY_NOTE)
        : warning('empty-geometry', 'The old crosshair draws no visible colour, so an empty match proves nothing.')],
    [!draws, warning('export-draws-nothing', `The export has length ${chosenNative.length} and no dot, so the current game ` +
      'draws nothing for it, outline included (user capture, issue #11); the automatic model redraws such shapes as bars.')],
    [colorWarning, colorWarning],
    [settings.thickness === 0 && target.width !== 1 && !hasMask, warning('literal-zero-conflict', 'The literal-zero minimum conflicts with the requested screen-relative thickness.')],
    [settings.thickness > 0 && chosenNative.thickness === 0, warning('zero-thickness-branch',
      'A positive old thickness converts to new thickness 0, which this historical model draws as 1 px and the automatic ' +
      'model as nothing; the current game is not checked, so this is not an exact match.')],
  ];
  for (const [condition, entry] of conditions) if (condition) warnings.push(entry);
  const moot = outlineChoiceMootWarning(settings, options, chosenNative.length);
  if (moot) warnings.push(moot);
  warnings.push(...outlineWarnings(settings, options), ...optionWarnings(settings, options), ...legacySettingWarnings(settings));
  // Every declared renderer id scales gap by `r` (renderer.js forward()). The build 2000914
  // dump does not say gap scales, so the chosen model is a hypothesis and its rival is not
  // ruled out. Residual modulation stays closed; see the v0.4 plan §2.7.
  warnings.push(warning('gap-scale-unresolved', 'The build 2000914 cvar description does not say how gap scales; this model ' +
    'scales it with length, and an unscaled gap is not ruled out.'));
  return warnings;
}

export function buildReport({ settings, o, legacy, target, state, visual, proposals, ranked, chosen, renderer, records, hasMask,
  targetOverride = null, blockers, started, certify = false, preserveZero = false }) {
  settings = structuredClone(settings); // never alias the caller's settings (rgb included)
  const converted = forward(chosen.native, o.currentHeight, renderer);
  const naive = naiveAssignment(settings, o.authoredHeight), naiveGeometry = forward(naive, o.currentHeight, renderer);
  const convertedFit = visual.score(converted);
  const exact = hasMask || targetOverride?.rasterConvention || targetOverride?.axisStart !== undefined ? {
    complete: false, count: null, sample: [], constrainedNearFar: target.length > 0,
    scope: 'Measured pixel preimage is not enumerated. The legacy arithmetic preimage does not describe this image target.',
  } : exactPreimage({ settings, options: o, model: renderer, preserveZero, targetOverride });
  const warnings = warningsFor(settings, state, visual, target, chosen.native, hasMask, o);
  const ratio = o.currentHeight / o.authoredHeight;
  const clamped = clampedOutputs(settings, { length: target.length / ratio, thickness: target.width / ratio,
    gap: (target.near - Math.floor(target.width / 2)) / ratio }, chosen.native, { ranges: NATIVE_RANGES, outlineMode: o.outlineMode });
  // Same old-against-new comparison as the community report; an image target has no old appearance to compare here.
  // A T flag forced by the T option (ADR-0025) draws the export with that flag.
  const forced = ['on', 'off'].includes(o.tShape) ? { t_style: o.tShape === 'on' } : {};
  const check = hasMask ? null : shapeCheck({ settings, target, converted, overrides: forced, options: o });
  return {
    // `targetBuild` is the build the historical hypotheses describe (and native measurements must come from);
    // the commands are formatted for `exportBuild`, the build the automatic converter tracks.
    schema: 'sicc-quant-report-v6', version: VERSION, targetBuild: BUILD, exportBuild: COMMUNITY_MODEL.build,
    options: o, settings, legacy, target, exportOverrides: {}, shapeCheck: check,
    targetKind: hasMask ? 'image-derived' : targetOverride ? 'measured-geometry' : 'synthetic-old-reconstruction',
    chosen, renderer, converted, naive, naiveGeometry,
    naiveFit: visual.score(naiveGeometry), convertedFit,
    rendering: { convention: RASTER_CONVENTION, evidence: 'Illustrative placement; not native-validated.',
      targetEdges: hasMask ? null : drawingEdges(target), convertedEdges: drawingEdges(converted),
      rawOffsets: 'Geometry near/far fields retain the arithmetic model offsets. Even-width synthetic bars draw the far edge one pixel earlier. Measured masks are unchanged.' },
    confidence: { nativeMatchProbability: null, status: state.mode, conditionalFamilyMass: chosen.exactMass,
      expectedShapeOverlap: chosen.expectedIou, priorSensitivity: chosen.priorSensitivity,
      interpretation: 'Conditional agreement within an explicit hypothesis set, not calibrated native correctness.' },
    posterior: state,
    models: MODELS.map((m, i) => ({ ...m, weight: state.weights[i], native: proposals[i].native,
      conditionalIou: proposals[i].visual.iou, geometryLoss: proposals[i].visual.geometryLoss,
      inverseCertificate: proposals[i].inverseCertificate, refinement: proposals[i].trace })),
    candidates: ranked.candidates.map(({ scores, ...candidate }) => candidate),
    preimage: { model: renderer.id, complete: exact.complete, count: exact.count,
      constrainedNearFar: exact.constrainedNearFar, sample: exact.sample, scope: exact.scope },
    decision: { rule: ranked.decision, searchPolicy: ranked.searchPolicy, certificate: ranked.certificate, trace: ranked.decisionTrace,
      scope: certify
        ? 'Best among evaluated legal proposals plus the opt-in certified expansion over the declared integer domain. A global claim is made only for the states named by certificate.method; shell-monotone relies on a documented, spot-checked monotonicity assumption, and unproven/not-evaluated makes no global claim.'
        : 'Best among evaluated legal proposals and two bounded neighborhood passes, including two-cell length jumps. No global claim: pass certify: true to attempt a certified global expansion.' },
    coverage: localSupport(settings, records), experiment: proposeExperiment(state), blockers,
    warnings, clamped,
    search: { maxRefinementPasses: 2, maxNeighborsPerPass: 124, maxDecisionPasses: 2, maxCandidates: 81,
      certifiedCandidates: certify && !chosen.manual ? ranked.candidates.length : 0,
      certifiedEvaluations: ranked.certificate?.evaluated ?? 0,
      proposalEvaluations: proposals.reduce((n, p) => n + p.evaluations, 0),
      uniqueShapeEvaluations: visual.size(), uniqueRasterEvaluations: 0, engine: visual.engine,
      durationMs: performance.now() - started,
      status: visual.targetArea === 0 ? 'empty-shape' : convertedFit.iou === 1 ? 'exact-under-selected-simulation' : 'bounded-search-ended-with-residual',
      nativeEvidenceUpdatedBySyntheticLoop: false },
  };
}
