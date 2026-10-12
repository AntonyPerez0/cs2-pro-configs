/**
 * Structural forward and inverse for the new cvar geometry.
 *
 * This is a HYPOTHESIS family, not a measured CS2 renderer. See
 * docs/math/02-conversion-and-identifiability.md.
 *
 * Four maps are kept separate; this file owns only the new structural forward `R_φ`
 * and its inverse `S_φ`:
 *
 *   x, H_o --F_old--> z_o     lib/geometry/legacy.js FROZEN
 *   z_o, goal, H --T--> z_*   renderer.targetGeometry unchanged
 *   z_*, x, H, A --S_φ--> v   invertStructural       this file
 *   v, H --R_φ--> ẑ          structuralForward      this file
 *
 * `φ` is a discrete hypothesis. It is not a fitted parameter and it is not the shipped
 * default. `infer()` is unchanged by this module.
 */
import { targetGeometry } from './renderer.js';
import { NATIVE_RANGES, validateNative } from '../settings/native.js';
import { DUMP_DESCRIPTION_FACTS } from '../settings/cvars.js';
import { bestInteger } from './inverse.js';
import { height as validHeight } from '../settings/validation.js';
import { quantize } from '../geometry/quantize.js';

export const STRUCTURAL_VERSION = 'structural-forward-v1';

const EPS = 1e-9;
const SNAP = 1e-9;

export const LENGTH_REFS = Object.freeze(['authored', 'current', '1080', '720', '480']);
export const QUANTIZERS = Object.freeze(['trunc', 'nearest', 'ceil']);
export const GAP_SCALES = Object.freeze(['same-as-length', 'unscaled']);
export const GAP_BASES = Object.freeze(['thickness-half', 'center', 'opening-half']);
export const ZERO_BRANCHES = Object.freeze(['preserve-literal', 'positive-minimum']);

/** The default displayed hypothesis maps the shipped `authored:trunc:thickness` model. */
export const DEFAULT_PHI = Object.freeze({
  lengthRef: 'authored', thicknessRef: 'authored',
  quantLength: 'trunc', quantThickness: 'trunc', quantGap: 'trunc',
  gapScale: 'same-as-length', gapBase: 'thickness-half',
  zeroBranch: 'preserve-literal', farDelta: 1,
  biasLength: 0, biasThickness: 0, biasGap: 0,
});

function enumField(phi, key, allowed) {
  if (!allowed.includes(phi[key])) throw new Error(`Unknown structural ${key} "${phi[key]}".`);
}

/** Reject unknown enum values and any v1-unsupported farDelta/bias. */
export function validatePhi(phi) {
  if (!phi || typeof phi !== 'object' || Array.isArray(phi)) throw new TypeError('Structural hypothesis must be an object.');
  enumField(phi, 'lengthRef', LENGTH_REFS);
  enumField(phi, 'thicknessRef', LENGTH_REFS);
  enumField(phi, 'quantLength', QUANTIZERS);
  enumField(phi, 'quantThickness', QUANTIZERS);
  enumField(phi, 'quantGap', QUANTIZERS);
  enumField(phi, 'gapScale', GAP_SCALES);
  enumField(phi, 'gapBase', GAP_BASES);
  enumField(phi, 'zeroBranch', ZERO_BRANCHES);
  if (phi.farDelta !== 1) throw new Error('Structural v1 supports farDelta 1 only.');
  for (const key of ['biasLength', 'biasThickness', 'biasGap'])
    if (phi[key] !== 0) throw new Error(`Structural v1 rejects a non-zero ${key}.`);
  return phi;
}

function phiIdUnchecked(phi) {
  return [
    `lr=${phi.lengthRef}`, `tr=${phi.thicknessRef}`,
    `ql=${phi.quantLength}`, `qt=${phi.quantThickness}`, `qg=${phi.quantGap}`,
    `gs=${phi.gapScale}`, `gb=${phi.gapBase}`, `zb=${phi.zeroBranch}`,
    `fd=${phi.farDelta}`, `bl=${phi.biasLength}`, `bt=${phi.biasThickness}`, `bg=${phi.biasGap}`,
  ].join('|');
}

/** Stable, sorted, space-free identifier. */
export function phiId(phi) { validatePhi(phi); return phiIdUnchecked(phi); }

/** The 24-hypothesis reduced set: thicknessRef = lengthRef, one shared quantizer. */
export function enumerateReducedFamily() {
  const out = [];
  for (const lengthRef of ['authored', '1080', '720'])
    for (const quant of ['trunc', 'nearest'])
      for (const gapScale of ['same-as-length', 'unscaled'])
        for (const gapBase of ['thickness-half', 'center'])
          out.push({ ...DEFAULT_PHI, lengthRef, thicknessRef: lengthRef,
            quantLength: quant, quantThickness: quant, quantGap: quant, gapScale, gapBase });
  return out;
}

function referenceHeight(ref, currentHeight, authoredHeight) {
  if (ref === 'authored') return authoredHeight;
  if (ref === 'current') return currentHeight;
  if (ref === '1080') return 1080;
  if (ref === '720') return 720;
  if (ref === '480') return 480;
  throw new Error(`Unknown reference height "${ref}".`);
}

/** Unchecked predict. Callers must already have validated native, currentHeight and phi. */
function predict(native, currentHeight, phi) {
  const rL = currentHeight / referenceHeight(phi.lengthRef, currentHeight, native.authoredHeight);
  const rT = currentHeight / referenceHeight(phi.thicknessRef, currentHeight, native.authoredHeight);
  // Gap ratio is the LENGTH ratio when scaled, per the plan. Never a separate thickness ratio.
  const rG = phi.gapScale === 'same-as-length' ? rL : 1;
  const length = Math.max(0, quantize(rL * native.length + phi.biasLength, phi.quantLength));
  const minimumBranch = native.thickness === 0 && phi.zeroBranch === 'preserve-literal';
  const width = Math.max(1, quantize(rT * native.thickness + phi.biasThickness, phi.quantThickness));
  const u = quantize(rG * native.gap + phi.biasGap, phi.quantGap);
  const near = phi.gapBase === 'thickness-half' ? Math.floor(width / 2) + u
    : phi.gapBase === 'center' ? u : (u - 1) / 2;
  const far = near + phi.farDelta;
  return { length, width, near, far, interval: length ? 2 * near + phi.farDelta : null,
    scaleLength: rL, scaleThickness: rT, scaleGap: rG, minimumBranch, phiId: phiIdUnchecked(phi) };
}

/** Validate, then run the structural forward `R_φ`. UI callers stay safe. */
export function structuralForward(native, currentHeight, phi) {
  if (!native || typeof native !== 'object') throw new TypeError('Structural native must be an object.');
  validateNative(native);
  validHeight(currentHeight);
  validatePhi(phi);
  return predict(native, currentHeight, phi);
}

function snapInteger(x) { const n = Math.round(x); return Math.abs(x - n) < SNAP ? n : x; }

/** Integer v in a real interval. `closed` flags inclusive ends. */
function integerInterval(loReal, hiReal, loClosed, hiClosed, max) {
  const lo0 = snapInteger(loReal), hi0 = snapInteger(hiReal);
  let lo = loClosed ? Math.ceil(lo0) : Math.floor(lo0) + 1;
  let hi = hiClosed ? Math.floor(hi0) : Math.ceil(hi0) - 1;
  lo = Math.max(0, lo); hi = Math.min(max, hi);
  return [lo, hi];
}

function closestInRange(lo, hi, ideal) {
  if (ideal <= lo) return lo;
  if (ideal >= hi) return hi;
  const f = Math.floor(ideal), c = Math.ceil(ideal);
  return Math.abs(f - ideal) <= Math.abs(c - ideal) ? f : c; // ties keep the smaller integer
}

function lengthResult(value, predicted, targetLength, r, max) {
  const ideal = targetLength / r;
  return { value, predicted, error: Math.abs(predicted - targetLength), ideal,
    inRange: ideal >= 0 && ideal <= max };
}

/** Full domain scan for length. Kept as the oracle the interval shortcut is checked against. */
export function inverseLengthScan(targetLength, r, quant, max = NATIVE_RANGES.length.max) {
  let best = null;
  for (let value = 0; value <= max; value++) {
    const predicted = quantize(value * r, quant), error = Math.abs(predicted - targetLength), tie = Math.abs(value - targetLength / r);
    if (!best || error < best.error || (error === best.error && tie < best.tie)) best = { value, predicted, error, tie };
  }
  return lengthResult(best.value, best.predicted, targetLength, r, max);
}

/**
 * Interval inversion for `trunc` and `nearest` (plan §3.1). Exact-equivalent to the scan,
 * including the ideal-value tie-break; falls back to the scan when no integer interval
 * exists (end saturation) or the quantizer has no interval form.
 */
export function inverseLengthInterval(targetLength, r, quant, max = NATIVE_RANGES.length.max) {
  if (quant !== 'trunc' && quant !== 'nearest') return inverseLengthScan(targetLength, r, quant, max);
  const ideal = targetLength / r;
  const candidates = targetLength % 1 === 0 ? [targetLength] : [Math.floor(targetLength), Math.ceil(targetLength)];
  let best = null;
  for (const k of candidates) {
    if (k < 0) continue;
    const bounds = quant === 'trunc'
      ? integerInterval(k / r, (k + 1) / r, true, false, max)
      : integerInterval((k - 0.5) / r, (k + 0.5) / r, true, false, max);
    if (bounds[0] > bounds[1]) continue;
    const value = closestInRange(bounds[0], bounds[1], ideal);
    const predicted = quantize(value * r, quant);
    const error = Math.abs(predicted - targetLength), tie = Math.abs(value - ideal);
    if (!best || error < best.error || (error === best.error && tie < best.tie)) best = { value, predicted, error, tie };
  }
  if (!best) return inverseLengthScan(targetLength, r, quant, max);
  return lengthResult(best.value, best.predicted, targetLength, r, max);
}

function inverseLength(targetLength, r, quant, max) {
  return quant === 'trunc' || quant === 'nearest'
    ? inverseLengthInterval(targetLength, r, quant, max)
    : inverseLengthScan(targetLength, r, quant, max);
}

function solveGap(target, width, rG, phi) {
  const base = phi.gapBase === 'thickness-half' ? Math.floor(width / 2) : phi.gapBase === 'center' ? 0 : -0.5;
  const slope = phi.gapBase === 'opening-half' ? 0.5 : 1;
  const center = (target.near + target.far - phi.farDelta) / 2;
  const ideal = target.length ? (center - base) / (slope * rG) : 0;
  const nearAt = v => base + slope * quantize(v * rG, phi.quantGap);
  return bestInteger(NATIVE_RANGES.gap.max, ideal, v => {
    if (!target.length) return 0;
    const near = nearAt(v);
    return (near - target.near) ** 2 + (near + phi.farDelta - target.far) ** 2;
  });
}

function betterJoint(candidate, best) {
  if (!best) return true;
  if (candidate.loss !== best.loss) return candidate.loss < best.loss;
  return candidate.preference < best.preference;
}

function invertJoint(target, rT, rG, phi, preserveZero) {
  const values = preserveZero ? [0] : Array.from({ length: NATIVE_RANGES.thickness.max + 1 }, (_, i) => i);
  const gapCache = new Map();
  let best = null;
  for (const value of values) {
    const width = Math.max(1, quantize(value * rT, phi.quantThickness));
    if (!gapCache.has(width)) gapCache.set(width, solveGap(target, width, rG, phi));
    const gap = gapCache.get(width);
    const ideal = preserveZero ? 0 : target.width / rT;
    const thickness = { value, ideal, loss: (width - target.width) ** 2,
      tie: Math.abs(value - ideal), idealInRange: ideal >= 0 && ideal <= NATIVE_RANGES.thickness.max };
    const candidate = { thickness, gap, width, loss: thickness.loss + gap.loss, preference: thickness.tie + gap.tie };
    if (betterJoint(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * Structural inverse `S_φ`. Searches the documented integer ranges; authored height is an
 * input, not a searched dimension (searching it makes `(cvar, A)` non-identifiable).
 */
export function invertStructural(settings, options = {}, phi) {
  validatePhi(phi);
  const { legacy, target, options: o } = targetGeometry(settings, options);
  const rL = o.currentHeight / referenceHeight(phi.lengthRef, o.currentHeight, o.authoredHeight);
  const rT = o.currentHeight / referenceHeight(phi.thicknessRef, o.currentHeight, o.authoredHeight);
  const rG = phi.gapScale === 'same-as-length' ? rL : 1;
  const length = inverseLength(target.length, rL, phi.quantLength, NATIVE_RANGES.length.max);
  const preserveZero = settings.thickness === 0 && phi.zeroBranch === 'preserve-literal';
  const joint = invertJoint(target, rT, rG, phi, preserveZero);
  const native = { length: length.value, thickness: joint.thickness.value, gap: joint.gap.value, authoredHeight: o.authoredHeight };
  const predicted = predict(native, o.currentHeight, phi);
  const residuals = {
    length: Math.abs(predicted.length - target.length),
    thickness: Math.abs(predicted.width - target.width),
    near: Math.abs(predicted.near - target.near),
    far: Math.abs(predicted.far - target.far),
  };
  const arms = legacy.length > 0;
  const exactWithinModel = residuals.length < EPS && residuals.thickness < EPS
    && (!arms || (residuals.near < EPS && residuals.far < EPS));
  const warnings = [];
  if (!DUMP_DESCRIPTION_FACTS.gapScalingStatedInDump) {
    warnings.push(phi.gapScale === 'same-as-length'
      ? { code: 'gap-scale-unresolved', text: 'Gap scaling is not stated in the build 2000914 cvar description. This hypothesis scales gap with length. The unscaled-gap rival is not ruled out.' }
      : { code: 'gap-scale-rival', text: 'Gap scaling is not stated in the build 2000914 cvar description. This hypothesis leaves gap unscaled. The length-scaled rival is not ruled out.' });
  }
  if (settings.thickness > 0 && native.thickness === 0)
    warnings.push({ code: 'zero-thickness-branch', text: 'A positive legacy thickness resolved to new thickness 0 (the zero-thickness branch). How the current game ' +
      'draws thickness 0 is unverified: the preview raster draws nothing for width 0. See correction C03.' });
  return {
    version: STRUCTURAL_VERSION, id: phiIdUnchecked(phi), phi, status: 'hypothesis-not-native',
    native, predicted, target, legacy, options: o,
    residuals, exactWithinModel, warnings,
    solutions: { length, thickness: joint.thickness, gap: joint.gap },
    assumptions: [
      'authored height was supplied, not identified',
      'far displacement is fixed at one pixel',
      'candidate cvars are integers, aligned with the inspected displayprecision="0" sliders',
      'the old side is the frozen binary32 reconstruction; only the new side is newly modeled',
    ],
    scope: 'Exact only within this declared structural hypothesis and integer domain; it is not native validation and never a claim about Valve’s migration code.',
  };
}
