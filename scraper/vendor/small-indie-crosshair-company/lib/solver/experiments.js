import { MODELS, forward, geometryKey } from './renderer.js';
import { entropy } from './statistics.js';
import { finite, height as validateHeight, integer } from '../settings/validation.js';
import { validateNative } from '../settings/native.js';
let designs;
function makeDesigns() {
  const result = [];
  for (const currentHeight of [768, 960, 1080, 1440]) for (const authoredHeight of [720, 960, 1080]) for (const gap of [0, 1, 3, 7]) {
    const native = { length: 5, thickness: 3, gap, authoredHeight }, groups = new Map();
    MODELS.forEach((m, i) => {
      const key = geometryKey(forward(native, currentHeight, m));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    result.push({ native, currentHeight, groups: [...groups.values()] });
  }
  return result;
}

/** Noiseless prediction partitions, not noisy expected information gain. */
export function proposeExperiment(state) {
  designs ??= makeDesigns();
  let best = null;
  for (const design of designs) {
    const weights = design.groups.map(group => group.reduce((sum, i) => sum + state.weights[i], 0));
    const candidate = { native: { ...design.native }, currentHeight: design.currentHeight, disagreementBits: entropy(weights), outcomes: weights.length };
    if (!best || candidate.disagreementBits > best.disagreementBits + 1e-12) best = candidate;
  }
  return best;
}

/** Declared capture grid. It is a finite search space, not a claim about what the game renders. */
export const CANDIDATE_GRID = Object.freeze({
  length: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
  thickness: Object.freeze([1, 2, 3, 4]),
  gap: Object.freeze([0, 1, 2, 3, 4, 7]),
  authoredHeight: Object.freeze([720, 1080]),
  currentHeight: Object.freeze([720, 768, 960, 1080, 1440, 2160]),
});

/** Predicted outcome partition of the 27 hypotheses: groups of model indices sharing one geometryKey. */
export function partitionOf(native, currentHeight) {
  const groups = new Map();
  MODELS.forEach((m, i) => {
    const key = geometryKey(forward(native, currentHeight, m));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  });
  return [...groups.values()];
}

let candidateCache;
/** Deterministic finite design grid with its forward-computed partition. Order fixes the greedy tie-break. */
export function candidateDesigns() {
  if (candidateCache) return candidateCache;
  const result = [];
  for (const currentHeight of CANDIDATE_GRID.currentHeight)
    for (const authoredHeight of CANDIDATE_GRID.authoredHeight)
      for (const thickness of CANDIDATE_GRID.thickness)
        for (const gap of CANDIDATE_GRID.gap)
          for (const length of CANDIDATE_GRID.length) {
            const native = { length, thickness, gap, authoredHeight };
            result.push({ native, currentHeight, partition: partitionOf(native, currentHeight) });
          }
  return candidateCache = result;
}

function designOf(design) {
  if (!design || typeof design !== 'object' || Array.isArray(design)) throw new Error('Invalid candidate design.');
  const { native, currentHeight } = design;
  validateNative(native);
  validateHeight(currentHeight);
  return { native: { ...native }, currentHeight, partition: partitionOf(native, currentHeight) };
}

/**
 * Greedy weighted set cover over ordered model pairs. It is a synthetic capture PLAN:
 * perfect separation of declared predictions does not prove any hypothesis matches native pixels.
 */
export function discriminatingSet({ state, size = 4, candidates } = {}) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.weights)) throw new Error('A posterior state with model weights is required.');
  if (state.weights.length !== MODELS.length) throw new Error(`Weights must cover all ${MODELS.length} models.`);
  const weights = state.weights.map((w, i) => finite(w, `Weight for ${MODELS[i].id}`, 0, 1e9));
  integer(size, 'Discriminating set size', 1, 4096);
  const list = (candidates === undefined ? candidateDesigns() : candidates).map(designOf);

  const pairs = [];
  let weightedTotal = 0;
  for (let i = 0; i < MODELS.length; i++) for (let j = i + 1; j < MODELS.length; j++) {
    const weight = Math.min(weights[i], weights[j]);
    if (weight <= 1e-12) continue; // Pairs at least one near-zero hypothesis cannot contribute; they are excluded from the total.
    pairs.push({ i, j, weight, slot: pairs.length });
    weightedTotal += weight;
  }

  // Precompute each design's separated pair references so the cover loop only sums remaining mass.
  const separated = list.map(design => {
    const group = new Array(MODELS.length);
    design.partition.forEach((members, g) => members.forEach(i => group[i] = g));
    return pairs.filter(pair => group[pair.i] !== group[pair.j]);
  });

  const used = new Array(pairs.length).fill(false);
  const chosen = [];
  let weightedCovered = 0;
  for (let step = 0; step < size; step++) {
    let best = -1, bestCoverage = 0;
    for (let c = 0; c < list.length; c++) {
      let coverage = 0;
      for (const pair of separated[c]) if (!used[pair.slot]) coverage += pair.weight;
      if (coverage > bestCoverage + 1e-12) { best = c; bestCoverage = coverage; }
    }
    if (best < 0) break;
    let mass = 0, newlyCovered = 0;
    for (const pair of separated[best]) if (!used[pair.slot]) { used[pair.slot] = true; newlyCovered++; mass += pair.weight; }
    weightedCovered += mass;
    const design = list[best];
    chosen.push({
      native: { ...design.native }, currentHeight: design.currentHeight,
      newWeightedCoverage: mass, coveredPairs: newlyCovered, separatedPairs: separated[best].length,
      outcomes: design.partition.length, partition: design.partition.map(group => [...group]),
    });
  }
  const leftover = pairs.filter((pair, index) => !used[index]);
  return { size: chosen.length, separatesAll: leftover.length === 0, weightedCovered, weightedTotal,
    unseparatedPairs: leftover.map(pair => ({ models: [MODELS[pair.i].id, MODELS[pair.j].id], weight: pair.weight })),
    designs: chosen,
    scope: 'Synthetic prediction partitions of the declared 27-hypothesis family under the current weights. This is a capture PLAN, not a measurement: perfect synthetic separation does not prove native correctness, and models outside the family are not considered.' };
}
