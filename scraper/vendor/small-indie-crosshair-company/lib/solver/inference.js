/** Orchestration only. Formula definitions, search, evidence and output have separate ownership. */
import { MODELS, targetGeometry, unsupported } from './renderer.js';
import { solveTarget } from './inverse.js';
import { posterior } from './evidence.js';
import { visualContext, refineVisual } from './visual.js';
import { rankCandidates, selectRenderer, chosenCandidate, normalizeDecision, LOSS_KEYS } from './selection.js';
import { certifiedExpansion, certifyOptimum, objective } from './certify.js';
import { buildReport } from './report.js';
import { rgba } from '../settings/native.js';
import { bool } from '../settings/validation.js';
import { COMMUNITY_MODEL } from '../geometry/community.js';
import { inferCommunity } from './community.js';
import { mergedExportOverrides } from './export.js';

const DEFAULT_SEARCH_POLICY = 'radius-two-proposals-plus-length-two-v2';
const CERTIFIED_SEARCH_POLICY = 'bounded-neighborhood-plus-certified-expansion-v2';
const EPS = 1e-12;

function cheapCertificate(rule, native, loss) {
  const zero = loss <= EPS;
  return { global: zero, method: zero ? 'loss-zero' : 'not-evaluated', improved: false, evaluated: 0,
    radius: null, shellMargin: null, best: { native: { ...native }, loss },
    scope: zero
      ? 'The chosen native already attains the zero floor of the declared loss, so it is a global minimum under the enumerated hypothesis set.'
      : 'No global claim: the default bounded search does not enumerate the declared domain. Pass certify: true to attempt a certified global expansion.' };
}

/** Convenience wrapper: run the public solver, then certify its chosen native.
 * Separated from certify.js so the certificate module never imports the solver (no cycle). */
export function rankAndCertify({ settings, options, decision = 'expected', records = [] }) {
  const result = infer({ settings, options, decision, records });
  const height = result.options.currentHeight, source = result.settings ?? settings;
  const visual = visualContext(result.target, source);
  const { rule } = normalizeDecision(decision);
  const chosenLoss = objective(result.chosen.native, { state: result.posterior, height, visual, decision })[LOSS_KEYS[rule] ?? 'expectedLoss'];
  const certificate = certifyOptimum({ native: result.chosen.native, state: result.posterior, height, visual, decision,
    preserveZero: source.thickness === 0, authoredHeight: result.chosen.native.authoredHeight });
  return { chosen: result.chosen, certificate, inferredBetter: certificate.best.loss < chosenLoss - EPS };
}

/** Reports record the full override set the export passes to `nativeCommands` (style, outline mode, colour). */
const withExportedOverrides = report => ({ ...report, exportedOverrides: mergedExportOverrides(report) });

export function infer({ settings, options = {}, records = [], measurements = [], targetOverride = null,
  targetMask = null, selectedModelId = null, decision = 'expected', certify = false }) {
  const started = performance.now();
  rgba(settings);
  for (const key of ['dot', 't_style', 'outline', 'recoil', 'weapon_gap']) bool(settings[key], key);
  bool(certify, 'certify');
  // Reports keep their own copy: mutating the caller's object (rgb included) later cannot change an export.
  settings = structuredClone(settings);
  if (!Array.isArray(records) || records.length > 10000) throw new Error('Invalid bounded corpus.');
  if (selectedModelId === COMMUNITY_MODEL.id)
    return withExportedOverrides(inferCommunity({ settings, options, records, targetOverride, targetMask, measurements }));
  const { legacy, target, options: o } = targetGeometry(settings, options, targetOverride);
  if (targetMask && o.goal === 'screen' && o.oldHeight !== o.currentHeight)
    throw new Error('Image targets cannot silently rescale measured evidence. Match source pixels or keep the same height.');
  const state = posterior(measurements), renderer = selectRenderer(selectedModelId, state);
  const visual = visualContext(target, settings, targetMask), blockers = unsupported(settings);
  const proposals = MODELS.map(model => refineVisual(
    solveTarget(settings, o, model, target, legacy, targetOverride !== null), model, o.currentHeight, visual));
  const ranked = rankCandidates(proposals, state, o.currentHeight, visual, decision, !selectedModelId);
  const preserveZero = targetOverride === null && settings.thickness === 0;
  let chosen;
  if (certify === true && !selectedModelId) {
    const expansion = certifiedExpansion(ranked, { state, height: o.currentHeight, visual, decision,
      preserveZero, authoredHeight: o.authoredHeight });
    ranked.refresh();
    const entry = ranked.add(expansion.native);
    ranked.decisionTrace.push({ pass: 'certified', native: { ...expansion.native }, expectedLoss: entry.expectedLoss, worstCaseLoss: entry.worstCaseLoss });
    ranked.searchPolicy = CERTIFIED_SEARCH_POLICY;
    ranked.certificate = expansion.certificate;
    chosen = chosenCandidate(ranked, proposals, renderer, false);
  } else {
    chosen = chosenCandidate(ranked, proposals, renderer, Boolean(selectedModelId));
    const { rule } = normalizeDecision(decision);
    ranked.searchPolicy = DEFAULT_SEARCH_POLICY;
    ranked.certificate = cheapCertificate(rule, chosen.native, chosen[LOSS_KEYS[rule] ?? 'expectedLoss']);
  }
  return withExportedOverrides(buildReport({ settings, o, legacy, target, state, visual, proposals, ranked, chosen,
    renderer, records, hasMask: Boolean(targetMask), targetOverride, blockers, started, certify, preserveZero }));
}
