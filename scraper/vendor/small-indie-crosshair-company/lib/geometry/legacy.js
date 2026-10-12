import { finite, height as validHeight, cleanNumber } from '../settings/validation.js';

/** @typedef {number} LegacyUnit */ // raw cl_crosshairsize/thickness/gap value, unitless, may be fractional
/** @typedef {number} IntPx */ // integer game pixels after truncation
/** @typedef {number} GameHeight */ // integer in-game resolution height, pixels, 240-16384

/**
 * Model legacy-static-kz-f32-v1, not Valve renderer source.
 * Port of the geometry equations described by KZGlobalTeam at pinned source S01.
 * See docs/math/01-legacy-geometry.md for scope, half-open coordinates and evidence.
 * @param {{size: LegacyUnit, thickness: LegacyUnit, gap: LegacyUnit}} settings - old size/thickness/gap cvar values.
 * @param {GameHeight} height - old in-game resolution height.
 * @returns {{model: string, height: GameHeight, scale: number, length: IntPx, width: IntPx, gapOffset: IntPx, near: IntPx, far: IntPx, interval: (IntPx|null), minimumBranch: boolean}} old-model geometry.
 */
export function legacyGeometry({ size, thickness, gap }, height) {
  validHeight(height);
  finite(size, 'Legacy size', 0, 10000);
  finite(thickness, 'Legacy thickness', 0, 10000);
  finite(gap, 'Legacy gap');
  const f = Math.fround;
  const scale = f(height / 480);
  const length = Math.trunc(f(scale * f(size)));
  const width = Math.max(1, Math.trunc(f(scale * f(thickness))));
  const gapOffset = cleanNumber(Math.trunc(f(f(gap) + f(4))));
  const near = Math.floor(width / 2) + gapOffset;
  return {
    model: 'legacy-static-kz-f32-v1', height, scale, length, width, gapOffset,
    near, far: near + 1, interval: length > 0 ? 2 * near + 1 : null,
    minimumBranch: thickness === 0,
  };
}

/**
 * Return generator-coordinate comparators, NOT alternative measured CS2 renderers.
 * @param {{size: LegacyUnit, thickness: LegacyUnit}} settings - old size/thickness cvar values.
 * @param {GameHeight} height - in-game resolution height.
 * @returns {{round_scaled: [IntPx, IntPx], fixed_2x: [IntPx, IntPx], hauptrolle_preview: [IntPx, IntPx]}} [length, width] pairs per comparator model.
 */
export function comparators(settings, height) {
  const s = Math.fround(height / 480);
  const round = v => Math.floor(Math.fround(s * Math.fround(v)) + 0.5);
  return {
    round_scaled: [round(settings.size), Math.max(1, round(settings.thickness))],
    fixed_2x: [Math.trunc(settings.size * 2), Math.max(1, Math.trunc(settings.thickness * 2))],
    hauptrolle_preview: [Math.trunc(settings.size) * 2 + Number(Math.trunc(settings.size) > 2), settings.thickness * 2],
  };
}

/**
 * Positive input bucket for a rendered dimension before binary32 boundary effects.
 * @param {IntPx} pixels - target integer pixel count.
 * @param {GameHeight} height - in-game resolution height.
 * @returns {{lowerInclusive: LegacyUnit, upperExclusive: LegacyUnit}} real-number legacy-unit interval producing `pixels`.
 */
export function idealBucket(pixels, height) {
  finite(pixels, 'Pixels', 0, 1000000); validHeight(height);
  return { lowerInclusive: pixels * 480 / height, upperExclusive: (pixels + 1) * 480 / height };
}
