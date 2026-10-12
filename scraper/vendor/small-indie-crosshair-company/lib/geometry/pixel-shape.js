/** Exact unions of the illustrative integer pixel cells. Not an extracted game shader.
 * Complexity depends on rectangle edges, not on the size of the preview canvas.
 */
import { rectangles } from './raster.js';

/** @typedef {number} IntPx */ // integer game pixel coordinate
/** @typedef {{x0: IntPx, x1: IntPx, spans: Array<[IntPx, IntPx]>}} Band */ // vertical strip [x0,x1) with half-open y-spans
/** @typedef {{bands: Band[], area: number}} Shape */ // compiled union-of-rectangles pixel shape
/** @typedef {{side: number, data: Uint8Array, cropped?: boolean}} Mask */ // side x side binary mask, row-major, one byte per pixel

function mergedIntervals(intervals) {
  const result = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}

function areaOf(bands) {
  return bands.reduce((area, b) => area + (b.x1 - b.x0) *
    b.spans.reduce((length, [a, z]) => length + z - a, 0), 0);
}

/**
 * Half-open integer cells use exactly the same pixel-center test as raster().
 * @param {object} geometry - rendered geometry (length/width/near/far and optional rasterConvention).
 * @param {{dot?: boolean, t_style?: boolean}} [flags] - which extra pieces (dot, T-style omission) to include.
 * @returns {Shape} compiled band union and its pixel area.
 */
export function compileShape(geometry, flags = {}) {
  const boxes = rectangles(geometry, flags).map(r => ({
    x0: Math.ceil(r.x - .5), x1: Math.ceil(r.x + r.w - .5),
    y0: Math.ceil(r.y - .5), y1: Math.ceil(r.y + r.h - .5),
  })).filter(r => r.x1 > r.x0 && r.y1 > r.y0);
  const edges = [...new Set(boxes.flatMap(r => [r.x0, r.x1]))].sort((a, b) => a - b);
  const bands = [];
  for (let i = 1; i < edges.length; i++) {
    const [x0, x1] = [edges[i - 1], edges[i]];
    const spans = mergedIntervals(boxes.filter(r => r.x0 < x1 && r.x1 > x0).map(r => [r.y0, r.y1]));
    if (spans.length) bands.push({ x0, x1, spans });
  }
  return { bands, area: areaOf(bands) };
}

/**
 * Throw if `mask` is not an odd-sided 9-257 binary Uint8Array mask.
 * @param {Mask} mask - candidate target mask.
 * @returns {Mask} the same mask, for chaining.
 * @throws {Error} on invalid side, data shape, non-binary values, or non-boolean `cropped`.
 */
export function validateMask(mask) {
  const { side, data } = mask ?? {};
  if (!Number.isInteger(side) || side < 9 || side > 257 || side % 2 !== 1)
    throw new Error('Target mask side must be an odd integer from 9 to 257.');
  if (!(data instanceof Uint8Array) || data.length !== side * side)
    throw new Error('Target mask must contain one byte per pixel.');
  if (data.some(x => x !== 0 && x !== 1)) throw new Error('Target mask must be binary.');
  if (mask.cropped !== undefined && typeof mask.cropped !== 'boolean')
    throw new Error('Target mask crop state must be boolean.');
  return mask;
}

/**
 * Losslessly compile an independently measured mask, without fitting a template.
 * @param {Mask} mask - binary target mask, centered at (side-1)/2.
 * @returns {Shape} compiled band union and its pixel area, in centered pixel coordinates.
 */
export function compileMask(mask) {
  validateMask(mask);
  const { side, data } = mask, half = (side - 1) / 2, bands = [];
  let lastKey = '';
  for (let x = 0; x < side; x++) {
    const spans = [];
    let y = 0;
    while (y < side) {
      if (!data[y * side + x]) { y++; continue; }
      const start = y++;
      while (y < side && data[y * side + x]) y++;
      spans.push([start - half, y - half]);
    }
    const key = JSON.stringify(spans), previous = bands.at(-1);
    if (spans.length && previous && key === lastKey && previous.x1 === x - half) previous.x1++;
    else if (spans.length) bands.push({ x0: x - half, x1: x - half + 1, spans });
    lastKey = key;
  }
  return { bands, area: areaOf(bands) };
}

function intervalIntersection(a, b) {
  let i = 0, j = 0, length = 0;
  while (i < a.length && j < b.length) {
    length += Math.max(0, Math.min(a[i][1], b[j][1]) - Math.max(a[i][0], b[j][0]));
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return length;
}

/**
 * Compare two compiled shapes by exact pixel-set intersection/union.
 * @param {Shape} a - first shape.
 * @param {Shape} b - second shape.
 * @returns {{union: number, intersection: number, different: number, iou: (number|null), emptyAgreement: boolean, cropped: boolean, scope: string}} agreement metrics; `iou` is null when the union is empty.
 */
export function compareShapes(a, b) {
  let i = 0, j = 0, intersection = 0;
  while (i < a.bands.length && j < b.bands.length) {
    const x = a.bands[i], y = b.bands[j];
    const width = Math.max(0, Math.min(x.x1, y.x1) - Math.max(x.x0, y.x0));
    if (width) intersection += width * intervalIntersection(x.spans, y.spans);
    if (x.x1 < y.x1) i++;
    else j++;
  }
  const union = a.area + b.area - intersection;
  return { union, intersection, different: union - intersection, iou: union ? intersection / union : null,
    emptyAgreement: union === 0, cropped: false, scope: 'Full-domain illustrative binary geometry; not native evidence.' };
}

/**
 * Whether any part of `shape` falls outside a centered `side`-by-`side` inspection window.
 * @param {Shape} shape - compiled shape to test.
 * @param {number} side - odd inspection window side, in pixels.
 * @returns {boolean} true if any band or span extends past the window.
 */
export function outsideFrame(shape, side) {
  const half = (side - 1) / 2;
  return shape.bands.some(b => b.x0 < -half || b.x1 > half + 1 || b.spans.some(([a, z]) => a < -half || z > half + 1));
}
