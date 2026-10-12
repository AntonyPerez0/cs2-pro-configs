/** Source-labelled static reconstruction. See docs/research/converter-audit-2026-09-28.md.
 * Equations independently implemented from public observations; no native capture claim.
 */
import { legacyGeometry } from './legacy.js';
import { validateNative, NATIVE_RANGES_2000922 } from '../settings/native.js';
import { height as validHeight, cleanNumber } from '../settings/validation.js';
import { COMMUNITY_CONVENTION } from './raster.js';

export const COMMUNITY_MODEL = Object.freeze({
  id: 'community-static-2026-10', scale: 'authored', rounding: 'nearest', gap: 'center',
  name: 'Community static reconstruction', build: '2000922', version: 'community-static-v11',
});
/** Public v11 is retained at the user's request; this revision distinguishes objective/recognition changes. */
export const COMMUNITY_REVISION = 'visible-stroke-fit-2026-10-07';

/** Ties to even, including negative half-integers. Math.round uses a different tie rule. */
export function roundEven(value) {
  const lower = Math.floor(value), fraction = value - lower;
  return fraction < .5 || (fraction === .5 && lower % 2 === 0) ? lower : lower + 1;
}

/** At-rest gap offset of old style 5 (ADR-0018, old weapon_csbase.cpp L2025-2050): `RoundFloatToInt(distance *
 * ScreenHeight / 1200 + gap)` with the resting distance 4, in float arithmetic, rounded to nearest even. Every other
 * style drew `trunc(gap + 4)`, which `legacyGeometry` returns. */
const style5GapOffset = (gap, height) => {
  const f = Math.fround;
  return cleanNumber(roundEven(f(f(f(4 * height) / 1200) + f(gap))));
};

export function communityLegacy(settings, height) {
  const base = legacyGeometry(settings, height); // validates inputs; retains signed f32 gap arithmetic
  if (settings.style === 5) base.gapOffset = style5GapOffset(settings.gap, height);
  const scaled = value => Math.fround(base.scale * Math.fround(value));
  const length = roundEven(scaled(settings.size)), width = Math.max(1, roundEven(scaled(settings.thickness)));
  const near = Math.floor(width / 2) + base.gapOffset;
  return { ...base, model: 'legacy-community-f32-even-v1', length, width,
    near, far: near + 1, interval: length > 0 ? 2 * near + 1 : null };
}

/** Public community renderer: positive values survive downscaling; literal zero stays zero. */
export function communityDimension(value, ratio) {
  return value === 0 ? 0 : Math.max(1, Math.round(value * ratio));
}

/** Native values in `min..max` that draw within `step` pixels of the drawn size of `value`, or lie within `step` native
 * steps of it, whichever reaches further at this ratio; one per drawn size: the closest to `ideal`, then the smaller.
 * Below ratio 1 the pixel window reaches shapes a native window misses; above it the native steps reach further. */
export function pixelWindow(value, step, ratio, min, max, ideal) {
  const centre = communityDimension(value, ratio), chosen = new Map();
  for (let v = min; v <= max; v++) {
    const drawn = communityDimension(v, ratio), current = chosen.get(drawn);
    if ((Math.abs(drawn - centre) <= step || Math.abs(v - value) <= step) &&
      (current === undefined || Math.abs(v - ideal) < Math.abs(current - ideal))) chosen.set(drawn, v);
  }
  return [...chosen.values()].sort((p, q) => p - q);
}

export function communityForward(native, height) {
  validateNative(native, NATIVE_RANGES_2000922); validHeight(height);
  const scale = height / native.authoredHeight;
  const length = communityDimension(native.length, scale), width = communityDimension(native.thickness, scale);
  const near = communityDimension(native.gap, scale), far = near - width % 2;
  return { length, width, near, far, interval: length > 0 ? near + far : null, scale,
    model: COMMUNITY_MODEL.id, minimumBranch: native.thickness === 0, rasterConvention: COMMUNITY_CONVENTION };
}
