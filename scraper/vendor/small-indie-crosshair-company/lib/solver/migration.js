/**
 * Named old-to-new candidate hypotheses.
 *
 * None of these is native-correct and none is `infer().chosen`. They exist so a user or
 * test can inspect a named migration story side by side. `infer()` is unchanged.
 * See docs/math/02-conversion-and-identifiability.md.
 */
import { legacyGeometry } from '../geometry/legacy.js';
import { naiveAssignment } from './renderer.js';
import { DEFAULT_PHI, invertStructural } from './structural.js';
import { NATIVE_RANGES } from '../settings/native.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * "What if the new cvars were the old rendered pixels?" The old gap offset is a signed raw
 * pixel offset; the new gap range is 0–128. A negative offset is unrepresentable and is
 * clamped with an explicit residual. Length is never shifted to fake the overlap.
 */
export function pixelCopyCandidate(settings, oldHeight) {
  const z = legacyGeometry(settings, oldHeight);
  const thickness = settings.thickness === 0 ? 0 : clamp(z.width, 1, NATIVE_RANGES.thickness.max);
  const gapClamped = z.gapOffset < NATIVE_RANGES.gap.min || z.gapOffset > NATIVE_RANGES.gap.max;
  const gap = clamp(z.gapOffset, NATIVE_RANGES.gap.min, NATIVE_RANGES.gap.max);
  const warnings = [];
  if (gapClamped) warnings.push({ code: 'negative-gap-unrepresentable',
    text: `The reconstructed old gap offset ${z.gapOffset} is outside the new gap range ${NATIVE_RANGES.gap.min}–${NATIVE_RANGES.gap.max} and was clamped to ${gap}. The overlap cannot be stored in this cvar; no length shift was applied to fake it.` });
  return { kind: 'pixel-copy', status: 'hypothesis-not-native',
    length: clamp(z.length, NATIVE_RANGES.length.min, NATIVE_RANGES.length.max),
    thickness, gap, authoredHeight: oldHeight,
    unclampedGap: z.gapOffset, gapClamped, legacy: z, warnings };
}

/** Today's `naiveAssignment`, named. It truncates old console numbers into the new ranges. */
export function renameCandidate(settings, authoredHeight) {
  return { kind: 'rename', status: 'hypothesis-not-native', ...naiveAssignment(settings, authoredHeight), warnings: [] };
}

/** Thin wrapper around the structural inverse `S_φ` in lib/solver/structural.js. */
export function structuralCandidate(settings, options, phi) {
  return { kind: 'structural', ...invertStructural(settings, options, phi) };
}

/** The one rival phi with an unscaled gap. Sensitivity only; not selected by `infer()`. */
const UNSCALED_PHI = Object.freeze({ ...DEFAULT_PHI, gapScale: 'unscaled' });

/**
 * Four labelled hypotheses for the Expert view. Display only: it never replaces
 * `infer().chosen`, and it does not mutate `settings` or `chosenNative`.
 * The shipped row is what the app currently exports, not a claim about Valve's migration.
 */
export function rivalSummary(settings, options = {}, chosenNative) {
  const o = options && typeof options === 'object' ? options : {};
  const authoredHeight = o.authoredHeight ?? o.currentHeight ?? o.oldHeight ?? 1080;
  const oldHeight = o.oldHeight ?? 1080;
  return [
    { kind: 'shipped', status: 'conditional-not-game-validated', native: { ...chosenNative } },
    { ...renameCandidate(settings, authoredHeight) },
    { ...pixelCopyCandidate(settings, oldHeight) },
    { ...structuralCandidate(settings, o, UNSCALED_PHI), kind: 'structural-unscaled' },
  ];
}
