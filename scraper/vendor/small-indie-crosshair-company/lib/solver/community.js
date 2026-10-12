/** Direct static conversion, deliberately outside the historical 27-model probability family. */
import { COMMUNITY_MODEL, communityLegacy, communityForward } from '../geometry/community.js';
import { drawingEdges, scaleScreenGeometry } from '../geometry/raster.js';
import { axisStartOf, snapToCells } from '../geometry/edge-cases.js';
import { legacyGeometry } from '../geometry/legacy.js';
import { scope, targetGeometry, naiveAssignment, unsupported } from './renderer.js';
import { searchCommunity } from './community-search.js';
import { refineAppearance } from './community-refine.js';
import { clampedOutputs, outlineWarnings, colorIndexWarning, legacySettingWarnings, outlineChoiceMootWarning } from './report.js';
import { visualContext } from './visual.js';
import { localSupport } from './corpus.js';
import { communityEvidence } from './community-evidence.js';
import { optionWarnings, effectiveOutlineMode, legacyOutlineExtent, LEGACY_STYLE_5_NOTE, styleTarget,
  exportFillAlpha } from '../settings/native.js';
import { edgeCaseTarget, edgeCaseOverrides, edgeCaseWarnings, shapeCheck, overpaintWarning, exportDraws,
  tFlipWarning, exportedAppearance, oldDrawability, undrawableWarning } from './community-edge.js';
import { aimShapeObjective, compareAimScores, IMPLEMENTATION_REVISION } from './aim-shape.js';
import { classifyShape } from '../geometry/shape-taxonomy.js';

const warn = (code, text) => ({ code, text });
/** The T flag the search starts from: the old one (`keep`), the plan's (`auto`, without a plan the old one) or forced. */
const exportedT = (settings, choice, shape) => choice === 'on' ? true : choice === 'off' ? false
  : choice === 'auto' && shape ? shape.exportT : settings.t_style;
const percent = value => `${Math.floor(100 * value)}%`;
/** Warning codes that explain why a shape check is approximate; `shape-approximate` is added when none applies. */
export const LOSS_WARNINGS = Object.freeze(['dimension-limit', 'appearance-refined', 'pixel-centering-shift',
  'corrections-fallback', 'corrections-off', 'export-draws-nothing', 'zero-length-outline-dropped', 'outline-overpaint-lost',
  'inverted-t-unrepresentable', 't-flipped-for-shape', 't-user-choice', 'outline-width-reduced', 'outline-asymmetric-approx',
  'outline-user-override', 'shape-approximate', 'aim-shape-preserved', 'old-shape-not-drawable']);
const SOURCE_SCOPE = 'Public converter observations and a community renderer reconstruction; not native-validated. ' +
  'Build 2000922 moved crosshair layout to a new native renderer; the equations are carried over from 2000918 unverified.';

/** Invert three monotone integer axes. Preserve bar dimensions before matching the centre radius, then (unless
 * `options.corrections` is false) run the visible-appearance refinement `refineAppearance`, which may
 * move the integers to draw the old visible pixels better. No statistical fit or learned weights.
 */
export function solveCommunity(settings, options = {}, measured = null, targetMask = null) {
  const o = scope(options), legacy = communityLegacy(settings, o.oldHeight);
  // Validate measured input through the existing public target contract.
  const source = measured ? targetGeometry(settings, { ...o, goal: 'pixels' }, measured).target : legacy;
  const factor = o.goal === 'screen' ? o.currentHeight / o.oldHeight : 1;
  const scaled = geometry => factor === 1 ? { ...geometry }
    : scaleScreenGeometry(geometry, o.oldHeight, o.currentHeight, !measured);
  const target = scaled(source), legacyInput = !measured && !targetMask && o.corrections;
  // Edge-case rules: fit a target with non-negative inner edges, score ties against the visible old shape. With the
  // automatic appearance corrections off the legacy target stays literal (plain dimension-first conversion).
  // A screen goal applies the rules to the whole pixels the scaled old shape covers, so the redrawn arms are sized in
  // current pixels; scaling an old-pixel redraw rounds its length and width apart (arms past the dot, folds that miss).
  const plan = edgeCaseTarget(source, settings, legacyInput), cells = factor !== 1 && plan.cases.length ? snapToCells(target) : null;
  // The T shape is read from the old pixels, also when a screen goal fits the snapped cells (ADR-0020).
  const snapped = cells && { ...edgeCaseTarget(cells, settings, true), tShape: plan.tShape };
  const path = snapped?.cases.length
    ? { plan: snapped, canonical: snapped.target, reference: snapped.reference === cells ? target : snapped.reference }
    : { plan, canonical: plan.target === source ? target : scaled(plan.target),
      reference: plan.reference === source ? target : scaled(plan.reference) };
  const solvePath = ({ plan: { tShape }, canonical, reference }, corrected) => {
    // ADR-0025: the exported T flag follows the T option, by default the old flag. ADR-0020 (`auto`): the search fits
    // with the planned flag (a cross where the old stem stuck out above the bar); on and off force it, also on the
    // plain path, whose plan has no T shape. The search scores against the old pixels drawn with the old flags.
    const flags = { ...settings, t_style: exportedT(settings, o.tShape, tShape) };
    const solved = { ...searchCommunity(canonical, flags, o, targetMask, reference, settings), flags };
    // Appearance window: a nearby tuple may draw the old visible pixels (colour and outline) better than the closest dimensions.
    // Score the actual exported outline, including hand choices. The plain fallback uses the same appearance.
    // Both goals use the exact sampled target, for every old outline width (ADR-0024).
    if (!corrected || settings.outline === undefined) return solved;
    return refineAppearance(solved, { settings, target, canonical, plan: path.plan,
      overrides: edgeCaseOverrides(settings, o, path.plan.cases), options: o });
  };
  const corrected = { ...path, solved: solvePath(path, legacyInput) };
  // A planned T change is a correction too, so it is checked against the plain conversion like the edge cases.
  const tChanged = Boolean(corrected.solved.flags.t_style) !== Boolean(settings.t_style);
  if (!path.plan.cases.length && !corrected.solved.refinement?.applied && !tChanged)
    return { ...corrected.solved, target, canonical: path.canonical, reference: path.reference, plan: path.plan,
      fallback: null, legacy, options: o };
  // Compare against corrections off using the same aiming/appearance objective. Preserving a dot may
  // sacrifice total outline coverage; the plain export wins only when the selected objective is strictly better.
  const plainPlan = edgeCaseTarget(source, settings, false), plain = { plan: plainPlan, canonical: target, reference: target };
  plain.solved = solvePath(plain, false);
  const objective = settings.outline === undefined ? null : aimShapeObjective(settings, target);
  const look = ({ solved }, cases) => objective
    ? objective.score(exportedAppearance({ settings, flags: solved.flags, target, converted: solved.predicted,
      overrides: edgeCaseOverrides(settings, o, cases), options: o }))
    : { aligned: visualContext(target, solved.flags, null, settings).aligned(solved.predicted) };
  const before = look(corrected, path.plan.cases), after = look(plain, []);
  const applied = compareAimScores(after, before) > 0, chosen = applied ? plain : corrected;
  return { ...chosen.solved, target, canonical: chosen.canonical, reference: chosen.reference, plan: chosen.plan,
    fallback: { applied, cases: path.plan.cases, refined: Boolean(corrected.solved.refinement?.applied),
      objective: objective?.rule ?? 'appearance-overlap',
      corrected: { native: corrected.solved.native, alignedIou: before.aligned, score: before },
      plain: { native: plain.solved.native, alignedIou: after.aligned, score: after } },
    legacy, options: o };
}

export function inferCommunity({ settings, options, records, targetOverride, targetMask, measurements }) {
  const started = performance.now(), solved = solveCommunity(settings, options, targetOverride, targetMask);
  const evidence = communityEvidence(measurements);
  const { native, predicted: converted, target, canonical, reference, plan, flags, legacy, options: o } = solved;
  if (targetMask && o.goal === 'screen' && o.oldHeight !== o.currentHeight)
    throw new Error('Image targets cannot silently rescale measured evidence. Match source pixels or keep the same height.');
  const visual = visualContext(reference, flags, targetMask, settings), convertedFit = visual.score(converted);
  // ADR-0020 (`auto`) or the T option may export another T flag than the old one; the override carries the flag the export uses.
  const tFlipped = Boolean(settings.t_style) !== Boolean(flags.t_style);
  const exportOverrides = { ...edgeCaseOverrides(settings, o, plan.cases), ...(tFlipped ? { t_style: flags.t_style } : {}) };
  const outlineScope = exportOverrides.outlineMode === undefined ? o : { ...o, outlineMode: exportOverrides.outlineMode };
  const naive = naiveAssignment(settings, o.authoredHeight), naiveGeometry = communityForward(naive, o.currentHeight);
  const baseline = legacyGeometry(settings, o.oldHeight);
  const warnings = [
    warn('community-reconstruction', SOURCE_SCOPE),
    warn('shape-loss-excludes-appearance',
      'Core overlap (no shift) measures the colored core only; outlines, alpha and recoil are excluded.'),
  ];
  if (settings.style === 5)
    warnings.push(warn('legacy-style-5-gap', LEGACY_STYLE_5_NOTE(o.oldHeight, legacy.gapOffset, baseline.gapOffset)));
  if (!targetOverride && (baseline.length !== legacy.length || baseline.width !== legacy.width))
    warnings.push(warn('legacy-rounding-disagreement',
      'Rounding and dropping the fraction give your old size or thickness different whole pixels; the converter rounds, ' +
      'as other converters and community measurements do, so the old game may have drawn it 1 px smaller.'));
  const check = shapeCheck({ settings, flags, target, converted, overrides: exportOverrides, options: o, targetMask });
  // Measured targets remain literal and never inherit a guessed old-renderer taxonomy or aiming priority.
  const blockers = unsupported(settings);
  const identity = targetMask || targetOverride || blockers.length ? null : aimShapeObjective(settings, target);
  const aimScore = identity?.score(exportedAppearance({ settings, flags, converted, overrides: exportOverrides, options: o }));
  const exportedSettings = { ...flags, style: styleTarget(settings, o.styleTarget), weapon_gap: false,
    alpha_enabled: true, alpha: exportFillAlpha(settings),
    ...(exportOverrides.color ? { color: 5, rgb: exportOverrides.color.rgb,
      alpha_enabled: true, alpha: exportOverrides.color.alpha } : {}) };
  const taxonomy = identity ? { source: identity.taxonomy,
    converted: classifyShape(converted, exportedSettings, { legacy: false, outlineMode: outlineScope.outlineMode }) } : null;
  // A property of the old look alone, so it holds with corrections off and for every export (ADR-0028).
  const drawable = identity ? oldDrawability(settings, target) : null;
  if (drawable?.impossible) warnings.push(undrawableWarning(drawable));
  const oddWidth = Boolean(converted.width % 2 || canonical.width % 2);
  // Every shifted export names the shift: odd widths centre on other pixels, and scaling rounds the edges apart.
  if ((oddWidth && check.status !== 'exact') || check.status === 'shifted')
    warnings.push(warn('pixel-centering-shift', oddWidth
      ? 'Odd-width bars sit on a different centre pixel in the new game, so the crosshair may appear 1 px off.'
      : 'Rounding the old shape to whole pixels on your screen moves it by up to 1 px.'));
  if (solved.fallback?.applied)
    warnings.push(warn('corrections-fallback', 'The plain conversion better matches the selected aiming/appearance objective ' +
      '(shape check ' +
      `${percent(solved.fallback.plain.alignedIou)} against ${percent(solved.fallback.corrected.alignedIou)}, best over 1 px ` +
      'shifts), so it is exported without the automatic appearance corrections.'));
  if (solved.refinement?.applied)
    warnings.push(warn('appearance-refined',
      'A different length, thickness or gap better matches the selected aiming-shape objective than the closest sizes, ' +
      'so it is exported. Dot-like visible cores prioritize the aiming pixels before outline coverage.'));
  else if (check.status !== 'exact' &&
    (converted.length !== canonical.length || converted.width !== canonical.width || converted.near !== solved.radius))
    warnings.push(warn('dimension-limit',
      'Integer steps or setting limits keep at least one dimension from matching the old one.'));
  if (solved.solutions.gap.ideal < 0)
    warnings.push(warn('negative-gap-static-unverified',
      'Build 2000922 enables a negative cl_crosshair_gap only for Classic Dynamic, and Static Cross with a negative gap ' +
      'is not checked in game, so the overlap is clamped to gap 0.'));
  if (settings.thickness === 0)
    warnings.push(warn('visible-minimum', 'Old thickness 0 still drew a thin line, so the export uses a positive thickness.'));
  // Its text calls the export the closest shape the window found, which holds only for the corrected export.
  const overpaint = targetMask || targetOverride || !o.corrections || solved.fallback?.applied ? null
    : overpaintWarning(settings, target, check.status);
  const exportedMode = effectiveOutlineMode(settings, outlineScope.outlineMode);
  if (o.corrections && identity?.preserve && check.status === 'approximate') warnings.push(warn('aim-shape-preserved',
    `The old visible aiming shape is a dot${identity.taxonomy.hiddenCorePixels ? ' after its outlines cover the arms' : ''}. ` +
    `The export prioritizes those aiming pixels (${percent(aimScore.alignedAim)} overlap after alignment); ` +
    `total appearance overlap, including outline differences, is ${percent(check.alignedIou)}. ` +
    'These are model comparisons, not in-game validation.'));
  const draws = exportDraws({ settings, flags, converted, overrides: exportOverrides, options: o });
  if (!o.corrections && !targetMask && !targetOverride)
    warnings.push(warn('corrections-off', 'Automatic appearance corrections are off, so the export is the plain ' +
      'conversion: crossed arms clamp to gap 0, size 0 keeps length 0 and no nearby value is tried' + (draws ? '.'
      : ', and this export draws nothing in the current game, outline included.')));
  if (tFlipped && o.tShape === 'auto') warnings.push(tFlipWarning(plan.tShape));
  warnings.push(...edgeCaseWarnings({ ...settings, t_style: flags.t_style }, plan, check.status, exportedMode),
    ...(overpaint ? [overpaint] : []),
    ...outlineWarnings(settings, outlineScope),
    ...optionWarnings(settings, o), ...legacySettingWarnings(settings, exportOverrides));
  const color = colorIndexWarning(settings), moot = outlineChoiceMootWarning(flags, o, native.length);
  if (color) warnings.push(color);
  if (moot) warnings.push(moot);
  if (visual.targetMask.cropped || (targetMask && convertedFit.cropped))
    warnings.push(warn('target-cropped',
      'The measured target or the new crosshair reaches the image edge, so the image cannot be matched completely.'));
  // Only when the export draws nothing: a sub-pixel old shape can still convert to visible bars. An old shape that drew
  // pixels (outline strokes, an image) is not empty; the export then loses all of it.
  if (!draws) warnings.push(check.status === 'empty'
    ? warn('empty-geometry', 'The old crosshair draws no visible colour, so an empty match proves nothing.')
    : warn('export-draws-nothing', `The old crosshair drew visible pixels, but the export has length ${native.length} and ` +
      'no dot, so the current game draws nothing for it, outline included (user capture, issue #11).' +
      (o.corrections ? '' : ' Turn on Automatic appearance corrections to redraw it as bars.')));
  // Every approximate export names at least one cause of the loss.
  if (check.status === 'approximate' && !warnings.some(entry => LOSS_WARNINGS.includes(entry.code)))
    warnings.push(warn('shape-approximate', `The export draws ${percent(check.alignedIou)} of the old visible pixels ` +
      '(best over 1 px shifts) because integer steps and whole-pixel rounding change the shape.'));
  if (evidence.gapCapturesUnmodeled)
    warnings.push(warn('native-capture-outside-model',
      `${evidence.gapCapturesUnmodeled} native capture(s) use a gap outside 0–128; they are listed but not evaluated.`));
  if (evidence.holdoutTests.some(group => !group.matches))
    warnings.unshift(warn('native-holdout-conflict', 'The reconstruction conflicts with at least one supplied native holdout group.'));
  const trace = [{ pass: 0, native, iou: convertedFit.iou, loss: convertedFit.loss,
    reason: 'Minimum dimension errors, closest radius per tied width, then shift-aligned and exact overlap across all resulting shapes.' }];
  const certificate = { global: false, method: 'not-evaluated', improved: false, evaluated: solved.axisEvaluations,
    scope: 'Exact per-axis size fit, not a global pixel-overlap optimum or a native match certificate.' };
  const preimage = { model: COMMUNITY_MODEL.id, complete: false, count: null, sample: [],
    constrainedNearFar: canonical.length > 0,
    scope: 'Pixel preimage is not enumerated for the community reconstruction. No exact-match count is claimed.' };
  const chosen = { native, trace, solutions: solved.solutions, refined: false, inverseCertificate: null,
    traceModelId: COMMUNITY_MODEL.id, proposedBy: [COMMUNITY_MODEL.id],
    exactMass: null, expectedIou: null, priorSensitivity: null };
  return {
    schema: 'sicc-quant-report-v6', version: COMMUNITY_MODEL.version, targetBuild: COMMUNITY_MODEL.build,
    exportBuild: COMMUNITY_MODEL.build, implementationRevision: IMPLEMENTATION_REVISION,
    options: o, settings, legacy, target, canonicalTarget: canonical, exportOverrides,
    edgeCase: { cases: plan.cases, fold: plan.fold, shift: plan.shift, tShape: plan.tShape ?? null,
      exportedFlags: { dot: flags.dot, t_style: flags.t_style } },
    targetKind: targetMask ? 'image-derived' : targetOverride ? 'measured-geometry' : 'community-old-reconstruction',
    taxonomy, drawability: drawable, aimingShape: identity ? { rule: o.corrections ? identity.rule : 'appearance-overlap',
      prioritized: o.corrections && identity.preserve,
      iou: aimScore.aimIou ?? null, alignedIou: aimScore.alignedAim ?? null,
      appearanceAtAimShift: aimScore.aimAlignedAppearance ?? null, shift: aimScore.aimShift ?? null } : null,
    provenance: { kind: 'external-community-model', nativeValidated: false,
      audit: 'docs/research/build-2000922-update-2026-10-01.md', scope: SOURCE_SCOPE },
    renderer: COMMUNITY_MODEL, chosen, converted, naive, naiveGeometry, convertedFit, naiveFit: visual.score(naiveGeometry),
    rendering: { convention: converted.rasterConvention, evidence: SOURCE_SCOPE,
      targetEdges: drawingEdges(canonical), convertedEdges: drawingEdges(converted) },
    confidence: { nativeMatchProbability: null, conditionalFamilyMass: null, expectedShapeOverlap: null,
      declaredResidualsPx: { length: converted.length - canonical.length, width: converted.width - canonical.width,
        axisStart: 0 - Math.ceil(converted.width / 2) - axisStartOf(canonical),
        ...(canonical.length > 0 ? { near: converted.near - drawingEdges(canonical).near,
          far: converted.far - drawingEdges(canonical).far } : {}) },
      minimumLossChoices: Object.fromEntries(Object.entries(solved.solutions).map(([key, value]) => [key, value.equivalents.length])),
      scope: 'Residuals and ambiguity are conditional on the reconstruction; no native-match probability is identified.' },
    posterior: { ...evidence, weights: [],
      warning: 'The automatic model is not one of the 27 historical models; select a historical model to see their weights.' },
    measurementChecks: evidence.measurementChecks,
    models: [{ ...COMMUNITY_MODEL, native, weight: null, conditionalIou: convertedFit.iou }], candidates: [chosen],
    preimage, decision: { rule: 'preserve-dimensions', searchPolicy: 'finite-dimension-ties-v4', certificate, trace,
      tieBreak: solved.tieBreak, refinement: solved.refinement ?? null, correctionsFallback: solved.fallback ?? null,
      scope: certificate.scope }, coverage: localSupport(settings, records), experiment: null,
    blockers, warnings,
    clamped: clampedOutputs(settings, Object.fromEntries(Object.entries(solved.solutions)
      .map(([key, value]) => [key, value.ideal])), native, { outlineMode: outlineScope.outlineMode }),
    shapeCheck: targetMask && convertedFit.cropped ? null : check,
    search: { maxCandidates: solved.tieBreak.evaluated, proposalEvaluations: solved.axisEvaluations,
      tieShapeEvaluations: solved.tieBreak.evaluated, uniqueShapeEvaluations: visual.size(), uniqueRasterEvaluations: 0,
      engine: visual.engine, durationMs: performance.now() - started, nativeEvidenceUpdatedBySyntheticLoop: false,
      status: 'source-labelled-static-conversion' },
  };
}
