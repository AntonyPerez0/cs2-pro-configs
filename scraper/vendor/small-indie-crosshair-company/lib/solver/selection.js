import { MODELS, DEFAULT_ID, getModel, forward, nativeKey } from './renderer.js';
import { neighbors } from './visual.js';
import { COMMUNITY_MODEL } from '../geometry/community.js';

export const DECISION_RULES = ['expected', 'worst', 'cvar'];
export const DEFAULT_ALPHA = .5;
/** Field name each declared decision rule minimizes. Shared so certificates cannot
 * disagree with the ranking search about what "loss" means. */
export const LOSS_KEYS = Object.freeze({ expected: 'expectedLoss', worst: 'worstCaseLoss', cvar: 'cvarLoss' });

/** The UI value that explicitly asks for the weighted 27-model hedge instead of the default. */
export const HEDGE_MODEL = 'weighted-hedge';

/** The app defaults to the sourced reconstruction. Historical evidence never silently changes its build. */
export function resolveModelChoice({ request = '' } = {}) {
  if (request === HEDGE_MODEL) return null;
  if (request) return request;
  return COMMUNITY_MODEL.id;
}

/** Prior-free weighted quantile over (value, weight) pairs. The first value whose
 * cumulative weight reaches q is returned; ties keep the lower value. Uses only the
 * declared weights, so no evidence is invented. */
export function weightedQuantile(pairs, q) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('Weighted quantile needs at least one pair.');
  if (!(q >= 0 && q <= 1)) throw new Error('Quantile must be in [0, 1].');
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) throw new Error('Weighted quantile needs positive total weight.');
  let seen = 0;
  for (const [value, weight] of sorted) { seen += weight; if (seen >= q * total - 1e-12) return value; }
  return sorted[sorted.length - 1][0];
}

/** Prior-free weighted CVaR: the weight-weighted mean of the worst `alpha` share of the
 * declared weight at level alpha. A boundary model contributes its partial weight.
 * Uses only state.weights; it is a declared decision rule, not a fitted risk model. */
export function weightedCvar(pairs, alpha = DEFAULT_ALPHA) {
  if (!Array.isArray(pairs) || !pairs.length) throw new Error('Weighted CVaR needs at least one pair.');
  if (!(alpha > 0 && alpha <= 1)) throw new Error('CVaR alpha must be in (0, 1].');
  const sorted = [...pairs].sort((a, b) => b[0] - a[0]);
  const total = sorted.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) throw new Error('Weighted CVaR needs positive total weight.');
  const target = alpha * total;
  let used = 0, sum = 0;
  for (const [value, weight] of sorted) {
    if (used >= target - 1e-15) break;
    const take = Math.min(weight, target - used);
    if (take <= 0) continue; // zero-weight models contribute no mass, not a stop condition
    sum += value * take; used += take;
  }
  return used > 0 ? sum / used : sorted[0][0];
}

/** Accept a rule name or { rule, alpha }; always return a plain string rule plus alpha.
 * Normalising here keeps report.js reading a string while callers may pass an object. */
export function normalizeDecision(decision) {
  const value = typeof decision === 'string' ? { rule: decision } : decision;
  if (!value || typeof value !== 'object') throw new Error('Unknown decision rule.');
  const rule = value.rule, alpha = value.alpha ?? DEFAULT_ALPHA;
  if (!DECISION_RULES.includes(rule) || typeof alpha !== 'number' || !(alpha > 0 && alpha <= 1))
    throw new Error('Unknown decision rule.');
  return { rule, alpha };
}

function agreementByScale(scores, weights) {
  return ['authored', 'reference1080', 'reference720'].map(scale => {
    let total = 0, exact = 0;
    MODELS.forEach((model, i) => {
      if (model.scale !== scale) return;
      total += weights[i];
      if (scores[i].iou === 1 && !scores[i].cropped) exact += weights[i];
    });
    return total ? exact / total : 0;
  });
}

function evaluate(native, state, height, visual, alpha = DEFAULT_ALPHA) {
  const scores = MODELS.map(m => visual.score(forward(native, height, m)));
  const weighted = fn => scores.reduce((sum, score, i) => sum + fn(score) * state.weights[i], 0);
  const scaleAgreement = agreementByScale(scores, state.weights);
  return { native, scores, proposedBy: [], cvarLoss: weightedCvar(scores.map((s, i) => [s.loss, state.weights[i]]), alpha), alpha,
    exactMass: weighted(s => Number(s.iou === 1 && !s.cropped)),
    expectedIou: weighted(s => s.iou ?? 0), expectedLoss: weighted(s => s.loss),
    worstCaseLoss: Math.max(...scores.map(s => s.loss)),
    priorSensitivity: [Math.min(...scaleAgreement), Math.max(...scaleAgreement)] };
}

function comparator(rule) {
  const key = rule === 'worst' ? 'worstCaseLoss' : rule === 'cvar' ? 'cvarLoss' : 'expectedLoss';
  return (a, b) => a[key] - b[key] || a.expectedLoss - b.expectedLoss || b.exactMass - a.exactMass ||
    a.native.length - b.native.length || a.native.thickness - b.native.thickness || a.native.gap - b.native.gap;
}

export function selectRenderer(id, state) {
  if (id) return getModel(id);
  const maximum = Math.max(...state.weights), reference = getModel(DEFAULT_ID);
  if (Math.abs(state.weights[MODELS.indexOf(reference)] - maximum) < 1e-12) return reference;
  return MODELS[state.weights.indexOf(maximum)];
}

/** Decision search uses the declared loss. It does not update the hypothesis likelihood. */
export function rankCandidates(proposals, state, height, visual, decision = 'expected', refine = true) {
  const { rule, alpha } = normalizeDecision(decision);
  const pool = new Map(), compare = comparator(rule), trace = [];
  function score(native) {
    const key = nativeKey(native);
    if (!pool.has(key)) pool.set(key, evaluate(native, state, height, visual, alpha));
    return pool.get(key);
  }
  for (const proposal of proposals) score(proposal.native).proposedBy.push(proposal.id);
  let best = [...pool.values()].sort(compare)[0];
  trace.push({ pass: 0, native: { ...best.native }, expectedLoss: best.expectedLoss, worstCaseLoss: best.worstCaseLoss });
  let probed = false;
  for (let pass = 1; refine && pass <= 2; pass++) {
    const before = best;
    for (const n of neighbors(best.native, proposals[0].preserveZero)) {
      const candidate = score(n);
      if (compare(candidate, best) < 0) best = candidate;
    }
    const localStagnation = nativeKey(before.native) === nativeKey(best.native);
    // Probe beyond a one-cell quantization plateau only after the ordinary local
    // pass would stop. The old trajectory stays in the pool and cannot regress.
    if (!probed && (localStagnation || pass === 2)) {
      probed = true;
      const probeOrigin = best.native;
      for (const delta of [-2, 2]) {
        const length = probeOrigin.length + delta;
        if (length < 0 || length > 255) continue;
        const candidate = score({ ...probeOrigin, length });
        if (compare(candidate, best) < 0) best = candidate;
      }
    }
    trace.push({ pass, native: { ...best.native }, expectedLoss: best.expectedLoss, worstCaseLoss: best.worstCaseLoss });
    if (nativeKey(before.native) === nativeKey(best.native)) break;
  }
  const candidates = [...pool.values()].sort(compare);
  const result = { candidates, decisionTrace: trace, byKey: pool, decision: rule, add: score, compare,
    // Re-sort the shared pool in place for callers that scored extra natives after construction
    // (the certified expansion). Additive only: the initial `candidates` array is unchanged.
    refresh() { result.candidates = [...pool.values()].sort(compare); return result.candidates; } };
  return result;
}

/** Keep the selected model's own trace: deduplication must not overwrite provenance. */
export function chosenCandidate(ranked, proposals, renderer, manual) {
  const proposal = proposals.find(p => p.id === renderer.id);
  const rankedChoice = manual ? ranked.byKey.get(nativeKey(proposal.native)) : ranked.candidates[0];
  const ownPath = nativeKey(proposal.native) === nativeKey(rankedChoice.native) ? proposal : null;
  return { ...rankedChoice, scores: undefined,
    trace: ownPath?.trace ?? ranked.decisionTrace.map(p => ({ ...p, reason: 'cross-scenario decision refinement' })),
    inverseCertificate: ownPath?.inverseCertificate ?? null,
    traceModelId: ownPath?.id ?? 'cross-scenario-decision', refined: Boolean(ownPath?.refined),
    solutions: ownPath?.solutions ?? null };
}
