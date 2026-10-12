/** Global-optimum certificates for the DECLARED decision loss.
 *
 * The declared objective is a property of the model set, the frozen visual target and
 * the decision weights. This module never claims native renderer correctness; it only
 * certifies or refuses to certify a minimum of the declared integer-domain loss.
 * The one non-enumerative claim (`shell-monotone`) is explicitly assumption-scoped.
 */
import { MODELS, forward } from './renderer.js';
import { normalizeDecision, weightedCvar, LOSS_KEYS } from './selection.js';

export const DECLARED_DOMAIN = Object.freeze({ length: [0, 255], thickness: [0, 31], gap: [0, 128] });
/** Documented deterministic fallback when full enumeration would be unaffordable. */
export const BOUNDED_DOMAIN = Object.freeze({ length: [0, 64], thickness: [0, 31], gap: [0, 64] });
/** Full-domain enumeration is ~1.06M cells; above this cap a scoped sub-domain is used. */
export const CERTIFY_FULL_CELL_LIMIT = 200000;
const EPS = 1e-12;

const lossKey = rule => LOSS_KEYS[rule] ?? 'expectedLoss';
const cellCount = domain => (domain.length[1] - domain.length[0] + 1) * (domain.thickness[1] - domain.thickness[0] + 1) * (domain.gap[1] - domain.gap[0] + 1);

function declaredDomain(preserveZero) {
  return { length: [...DECLARED_DOMAIN.length], thickness: preserveZero ? [0, 0] : [...DECLARED_DOMAIN.thickness], gap: [...DECLARED_DOMAIN.gap] };
}
function clampRange(range, fallback) {
  return [Math.max(fallback[0], range?.[0] ?? fallback[0]), Math.min(fallback[1], range?.[1] ?? fallback[1])];
}
function normalizeWindow(window, preserveZero) {
  const domain = declaredDomain(preserveZero), w = window ?? {};
  return { length: clampRange(w.length, domain.length), thickness: preserveZero ? [0, 0] : clampRange(w.thickness, domain.thickness), gap: clampRange(w.gap, domain.gap) };
}
function intersectWindow(window, domain) {
  const out = { length: [Math.max(window.length[0], domain.length[0]), Math.min(window.length[1], domain.length[1])],
    thickness: [Math.max(window.thickness[0], domain.thickness[0]), Math.min(window.thickness[1], domain.thickness[1])],
    gap: [Math.max(window.gap[0], domain.gap[0]), Math.min(window.gap[1], domain.gap[1])] };
  return out.length[0] <= out.length[1] && out.thickness[0] <= out.thickness[1] && out.gap[0] <= out.gap[1] ? out : null;
}

/** The single declared-objective entry point. Mirrors selection.evaluate so the
 * certificate and the ranking search cannot disagree about what is being minimized. */
export function objective(native, { state, height, visual, decision = 'expected' }) {
  const { rule, alpha } = normalizeDecision(decision);
  const scores = MODELS.map(model => visual.score(forward(native, height, model)));
  let expectedLoss = 0, worstCaseLoss = -Infinity;
  const pairs = [];
  for (let i = 0; i < scores.length; i++) {
    const loss = scores[i].loss, weight = state.weights[i];
    expectedLoss += loss * weight;
    if (loss > worstCaseLoss) worstCaseLoss = loss;
    pairs.push([loss, weight]);
  }
  return { native, scores, expectedLoss, worstCaseLoss, cvarLoss: weightedCvar(pairs, alpha), alpha, rule };
}

/** Enumerate integer natives in `window` (default: the full declared domain). Tie-breaks
 * follow ascending (length, thickness, gap) order so the result is deterministic. */
export function exhaustiveOptimum({ state, height, visual, decision = 'expected', preserveZero = false, window, authoredHeight = height }) {
  const { rule } = normalizeDecision(decision), key = lossKey(rule), range = normalizeWindow(window, preserveZero);
  let best = null, evaluated = 0;
  for (let length = range.length[0]; length <= range.length[1]; length++)
    for (let thickness = range.thickness[0]; thickness <= range.thickness[1]; thickness++)
      for (let gap = range.gap[0]; gap <= range.gap[1]; gap++) {
        const native = { length, thickness, gap, authoredHeight };
        const value = objective(native, { state, height, visual, decision });
        evaluated++;
        if (!best || value[key] < best.loss) best = { native, loss: value[key], objective: value };
      }
  const boundaryHit = ['length', 'thickness', 'gap'].some(k => best.native[k] === range[k][0] || best.native[k] === range[k][1]);
  return { native: best.native, loss: best.loss, objective: best.objective, evaluated, boundaryHit, window: range };
}

/** Cells at Chebyshev distance exactly `distance` from `center`, clipped to `domain`. */
function shellCells(center, distance, domain, preserveZero, authoredHeight) {
  const cells = [];
  for (let length = Math.max(domain.length[0], center.length - distance); length <= Math.min(domain.length[1], center.length + distance); length++)
    for (let thickness = Math.max(domain.thickness[0], center.thickness - distance); thickness <= Math.min(domain.thickness[1], center.thickness + distance); thickness++)
      for (let gap = Math.max(domain.gap[0], center.gap - distance); gap <= Math.min(domain.gap[1], center.gap + distance); gap++) {
        const d = Math.max(Math.abs(length - center.length), Math.abs(thickness - center.thickness), Math.abs(gap - center.gap));
        if (d === distance) cells.push({ length, thickness, gap, authoredHeight });
      }
  return cells;
}

function exhaustiveScope(domain, bounded) {
  const shape = `length ${domain.length[0]}..${domain.length[1]}, thickness ${domain.thickness[0]}..${domain.thickness[1]}, gap ${domain.gap[0]}..${domain.gap[1]}`;
  return bounded
    ? `Global minimum on the bounded sub-domain (${shape}); NOT the full declared domain.`
    : `Global minimum by full enumeration of the declared integer domain (${shape}).`;
}

function domainFallback(declared, { state, height, visual, decision, preserveZero, authoredHeight, current }) {
  const affordable = cellCount(declared) <= CERTIFY_FULL_CELL_LIMIT;
  const probe = affordable ? declared : normalizeWindow(BOUNDED_DOMAIN, preserveZero);
  const inside = (probe.length[0] <= current.native.length && current.native.length <= probe.length[1]) &&
    (probe.thickness[0] <= current.native.thickness && current.native.thickness <= probe.thickness[1]) &&
    (probe.gap[0] <= current.native.gap && current.native.gap <= probe.gap[1]);
  if (!affordable && !inside) return { global: false, method: 'unproven', best: current,
    reason: 'The current best lies outside the affordable bounded probe; no scoped enumeration covers it.',
    scope: 'No global claim.' };
  const result = exhaustiveOptimum({ state, height, visual, decision, preserveZero, window: probe, authoredHeight });
  return { global: true, method: 'domain-exhaustive', best: { native: result.native, loss: result.loss, objective: result.objective },
    evaluated: result.evaluated, domain: probe, scope: exhaustiveScope(probe, !affordable) };
}

/** Adaptive Chebyshev-shell certificate. A `true` global claim is only made when the
 * declared loss is already the zero floor, or a full in-domain shell is strictly worse
 * under the documented monotonicity assumption, or a scoped domain was enumerated. */
export function certifyOptimum({ native, state, height, visual, decision = 'expected', preserveZero = false,
  maxRadius = 6, domain = null, authoredHeight = native.authoredHeight ?? height }) {
  const { rule } = normalizeDecision(decision), key = lossKey(rule);
  const declared = domain ? normalizeWindow(domain, preserveZero) : declaredDomain(preserveZero);
  const declaredShape = `length ${declared.length[0]}..${declared.length[1]}, thickness ${declared.thickness[0]}..${declared.thickness[1]}, gap ${declared.gap[0]}..${declared.gap[1]}`;
  const start = objective({ ...native, authoredHeight }, { state, height, visual, decision });
  let best = { native: { ...native, authoredHeight }, loss: start[key], objective: start };
  if (best.loss <= EPS) return { global: true, method: 'loss-zero', best,
    reason: 'The chosen native already attains zero declared loss, the unweighted floor of the objective.',
    scope: `Global minimum of the declared loss on (${declaredShape}) under the enumerated hypothesis set.` };
  for (let radius = 1; radius <= maxRadius; radius++) {
    // Re-run the radius window around the current best to a fixpoint, so the closed
    // Chebyshev ball really has been enumerated before the shell is compared.
    let moved = true;
    while (moved) {
      moved = false;
      const window = intersectWindow({ length: [best.native.length - radius, best.native.length + radius],
        thickness: [best.native.thickness - radius, best.native.thickness + radius], gap: [best.native.gap - radius, best.native.gap + radius] }, declared);
      if (!window) continue;
      const inside = exhaustiveOptimum({ state, height, visual, decision, preserveZero, window, authoredHeight });
      if (inside.loss < best.loss - EPS) { best = { native: inside.native, loss: inside.loss, objective: inside.objective }; moved = true; }
    }
    const shell = shellCells(best.native, radius + 1, declared, preserveZero, authoredHeight);
    if (!shell.length) return domainFallback(declared, { state, height, visual, decision, preserveZero, authoredHeight, current: best });
    let minShell = Infinity;
    for (const cell of shell) {
      const value = objective(cell, { state, height, visual, decision });
      if (value[key] < minShell) minShell = value[key];
    }
    if (minShell > best.loss + EPS) return { global: true, method: 'shell-monotone', radius, best, shellMargin: minShell - best.loss,
      scope: `Global minimum on (${declaredShape}) under the documented assumption that the declared loss cannot decrease once every rendered geometric distance strictly grows from the best cell. The immediate Chebyshev shell is strictly worse; this assumption was checked offline against exhaustive enumeration, not proved.` };
  }
  return { global: false, method: 'unproven', best,
    reason: `No in-domain shell at radius <= ${maxRadius + 1} was strictly worse than the best cell; a remote or non-monotone optimum cannot be excluded by bounded expansion.`,
    scope: 'No global claim. Best evaluated cell under bounded expansion only.' };
}

function expansionCertificate({ global, method, improved, evaluated, radius, shellMargin, scope, best, loss, reason }) {
  const certificate = { global, method, improved, evaluated, radius, shellMargin, scope,
    best: { native: { ...best.native }, loss } };
  if (reason !== undefined) certificate.reason = reason;
  return certificate;
}

/** Enumerate the full declared domain through the ranking pool when bounded expansion has no
 * in-domain shell left to probe. A global claim is only made if every declared cell fits the
 * remaining budget; otherwise the result stays `unproven`. */
function expansionDomainFallback(ranked, { declared, key, budget, evaluated, improved, best, auth }) {
  const cells = cellCount(declared);
  const shape = `length ${declared.length[0]}..${declared.length[1]}, thickness ${declared.thickness[0]}..${declared.thickness[1]}, gap ${declared.gap[0]}..${declared.gap[1]}`;
  if (cells > budget - evaluated) return { native: best.native, loss: best[key], certificate: expansionCertificate({
    global: false, method: 'unproven', improved, evaluated, radius: null, shellMargin: null, reason: 'budget',
    scope: `No global claim: no in-domain shell exists around the best cell and the declared domain (${cells} cells) exceeds the remaining evaluation budget.`,
    best, loss: best[key] }) };
  let found = null, count = 0;
  for (let length = declared.length[0]; length <= declared.length[1]; length++)
    for (let thickness = declared.thickness[0]; thickness <= declared.thickness[1]; thickness++)
      for (let gap = declared.gap[0]; gap <= declared.gap[1]; gap++) {
        const candidate = ranked.add({ length, thickness, gap, authoredHeight: auth });
        count++;
        if (!found || candidate[key] < found[key]) found = candidate;
      }
  return { native: found.native, loss: found[key], certificate: expansionCertificate({
    global: true, method: 'domain-exhaustive', improved: improved || found.native !== best.native,
    evaluated: evaluated + count, radius: null, shellMargin: null, scope: exhaustiveScope(declared, false),
    best: found, loss: found[key] }) };
}

/**
 * Opt-in certified expansion of the bounded search over the ranking pool.
 *
 * Shells are enumerated around the current best. A strict improvement moves the best and
 * restarts; a full shell that is strictly worse certifies `shell-monotone` under the documented
 * (spot-checked, not proved) monotonicity assumption. A degenerate domain is enumerated instead.
 * Any budget exhaustion or radius cap returns `unproven`, which never claims a global optimum.
 */
export function certifiedExpansion(ranked, { state, height, visual, decision = 'expected', preserveZero = false,
  authoredHeight, maxRadius = 6, budget = 400000 }) {
  const { rule } = normalizeDecision(decision), key = LOSS_KEYS[rule] ?? 'expectedLoss';
  const declared = declaredDomain(preserveZero);
  const shape = `length ${declared.length[0]}..${declared.length[1]}, thickness ${declared.thickness[0]}..${declared.thickness[1]}, gap ${declared.gap[0]}..${declared.gap[1]}`;
  let best = ranked.candidates[0], evaluated = 0, improved = false;
  const auth = authoredHeight ?? best.native.authoredHeight;
  if (best[key] <= EPS) return { native: best.native, loss: best[key], certificate: expansionCertificate({
    global: true, method: 'loss-zero', improved: false, evaluated: 0, radius: null, shellMargin: null,
    scope: `Global minimum of the declared loss on (${shape}) under the enumerated hypothesis set: the starting cell already attains the zero floor.`,
    best, loss: best[key] }) };
  for (let radius = 1; radius <= maxRadius; radius++) {
    const shell = shellCells(best.native, radius, declared, preserveZero, auth);
    if (!shell.length) return expansionDomainFallback(ranked, { declared, key, budget, evaluated, improved, best, auth });
    let minShell = Infinity, minCell = null;
    for (const cell of shell) {
      const candidate = ranked.add(cell);
      evaluated++;
      if (candidate[key] < minShell) { minShell = candidate[key]; minCell = candidate; }
      if (evaluated > budget) return { native: best.native, loss: best[key], certificate: expansionCertificate({
        global: false, method: 'unproven', improved, evaluated, radius: null, shellMargin: null, reason: 'budget',
        scope: `No global claim: certified expansion exceeded its evaluation budget (${budget}).`,
        best, loss: best[key] }) };
    }
    if (minShell < best[key] - EPS) {
      best = minCell; improved = true;
      if (best[key] <= EPS) return { native: best.native, loss: best[key], certificate: expansionCertificate({
        global: true, method: 'loss-zero', improved, evaluated, radius: null, shellMargin: null,
        scope: `Global minimum of the declared loss on (${shape}) under the enumerated hypothesis set: expansion reached the zero floor.`,
        best, loss: best[key] }) };
      radius = 0; // restart the shell sweep around the new best
      continue;
    }
    const next = shellCells(best.native, radius + 1, declared, preserveZero, auth);
    if (!next.length) return expansionDomainFallback(ranked, { declared, key, budget, evaluated, improved, best, auth });
    let minNext = Infinity;
    for (const cell of next) {
      const candidate = ranked.add(cell);
      evaluated++;
      if (candidate[key] < minNext) minNext = candidate[key];
      if (evaluated > budget) return { native: best.native, loss: best[key], certificate: expansionCertificate({
        global: false, method: 'unproven', improved, evaluated, radius: null, shellMargin: null, reason: 'budget',
        scope: `No global claim: certified expansion exceeded its evaluation budget (${budget}).`,
        best, loss: best[key] }) };
    }
    if (minNext > best[key] + EPS) return { native: best.native, loss: best[key], certificate: expansionCertificate({
      global: true, method: 'shell-monotone', improved, evaluated, radius, shellMargin: minNext - best[key],
      scope: `Global minimum of the declared loss on (${shape}) under the documented monotonicity assumption: the full Chebyshev shell at distance ${radius + 1} is strictly worse, and the loss is assumed not to decrease once every rendered geometric distance strictly grows from the best cell. That assumption was spot-checked offline against exhaustive enumeration, not proved.`,
      best, loss: best[key] }) };
  }
  return { native: best.native, loss: best[key], certificate: expansionCertificate({
    global: false, method: 'unproven', improved, evaluated, radius: null, shellMargin: null, reason: 'radius-cap',
    scope: `No global claim: bounded expansion reached radius ${maxRadius} without a strictly worse shell, so a remote or non-monotone optimum cannot be excluded.`,
    best, loss: best[key] }) };
}
