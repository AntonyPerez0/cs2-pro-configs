/** Translation-aligned overlap for tie ranking. Old and new renderers centre odd widths on different
 * pixels (-floor(W/2) versus -ceil(W/2)); no cvar can move the whole crosshair, so a whole-shape shift of at most
 * one pixel is not a conversion error. Research code is never imported here.
 */
import { compareShapes } from '../geometry/pixel-shape.js';

/** Integer whole-shape shifts within ±1 px per axis, unshifted first. */
export const SHIFTS = Object.freeze([[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]
  .map(shift => Object.freeze(shift)));

/** A compiled shape moved by `[dx, dy]` pixels. */
export function shiftShape(shape, [dx, dy]) {
  if (!dx && !dy) return shape;
  return { area: shape.area, bands: shape.bands.map(b => ({ x0: b.x0 + dx, x1: b.x1 + dx,
    spans: b.spans.map(([a, z]) => [a + dy, z + dy]) })) };
}

/** Highest IoU of `shape` against `reference` over SHIFTS; null only when both shapes are empty. */
export function alignedIou(shape, reference) {
  let best = null;
  for (const shift of SHIFTS) {
    const { iou } = compareShapes(shiftShape(shape, shift), reference);
    if (iou !== null && (best === null || iou > best)) best = iou;
  }
  return best;
}
