/** Colour-labelled visible appearance. New renderer: the outline layer first and the core on top (fill over
 * outline per pixel). Old renderer: element by element, outline then fill (`legacyAppearance`). Exact on
 * coordinate-compressed integer cells (no canvas), so large shapes stay cheap.
 * Illustrative pixels under the declared models, not native evidence. */
import { rectangles, outlineRectangles, legacyElements, cell } from './raster.js';

const cells = r => ({ x0: cell(r.x), x1: cell(r.x + r.w), y0: cell(r.y), y1: cell(r.y + r.h) });
const layer = (rects, color) => ({ color, boxes: rects.map(cells).filter(r => r.x1 > r.x0 && r.y1 > r.y0) });

/**
 * Layers `[{ color, boxes }]`, later layers on top. Colours are compared with `===`, so pass strings.
 * @param {object} g - rendered geometry.
 * @param {{dot?: boolean, t_style?: boolean}} flags - dot and T flags.
 * @param {{low: number, high: number}} extent - outline pixels added left/top and right/bottom.
 * @param {{core: string, outline: string}} colors - colour keys of the two layers.
 * @param {boolean} [zeroLength] - outline zero-length bars (old renderer); defaults by convention.
 */
export function appearance(g, flags, extent, colors, zeroLength) {
  return [layer(outlineRectangles(g, flags, extent, undefined, zeroLength), colors.outline),
    layer(rectangles(g, flags), colors.core)];
}

/** Old renderer order: left, right, top, bottom, dot, each its outline and then its fill, so a later
 * outline paints over earlier fills. Zero-length bars keep their outline. Same layer format as `appearance`. */
export function legacyAppearance(g, flags, extent, colors) {
  return legacyElements(g, flags, extent).flatMap(e =>
    [layer(e.outline ? [e.outline] : [], colors.outline), layer(e.fill ? [e.fill] : [], colors.core)]);
}

/** Layers from a binary mask, for image targets: one core layer, no outline. */
export function maskAppearance(shape, color) {
  return [{ color, boxes: shape.bands.flatMap(b => b.spans.map(([y0, y1]) => ({ x0: b.x0, x1: b.x1, y0, y1 }))) }];
}

/** Layers painted on their own compressed axes: `grid` holds the top colour id per cell (0 = empty).
 * `ids` maps colour keys to shared positive ids, so two paintings compare by `===` on the keys. */
function paint(layers, ids) {
  const boxes = layers.flatMap(l => l.boxes);
  const axis = (lo, hi) => [...new Set(boxes.flatMap(r => [r[lo], r[hi]]))].sort((p, q) => p - q);
  const xs = axis('x0', 'x1'), ys = axis('y0', 'y1'), w = Math.max(0, xs.length - 1);
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  const grid = new Int32Array(w * Math.max(0, ys.length - 1));
  for (const { boxes: list, color } of layers) {
    if (!ids.has(color)) ids.set(color, ids.size + 1);
    const id = ids.get(color);
    for (const r of list) for (let j = yi.get(r.y0); j < yi.get(r.y1); j++)
      grid.fill(id, j * w + xi.get(r.x0), j * w + xi.get(r.x1));
  }
  return { xs, ys, w, grid };
}

/** Disjoint visible rectangles after all paint operations, retaining the final colour of each cell.
 * Coordinate compression makes this independent of screen size; no bitmap or clipping window is used. */
export function visibleRegions(layers) {
  const ids = new Map(), p = paint(layers, ids), colors = new Map([...ids].map(([color, id]) => [id, color]));
  const regions = [];
  for (let y = 0; y + 1 < p.ys.length; y++) for (let x = 0; x < p.w; x++) {
    const id = p.grid[y * p.w + x];
    if (id) regions.push({ color: colors.get(id), x0: p.xs[x], x1: p.xs[x + 1], y0: p.ys[y], y1: p.ys[y + 1] });
  }
  return regions;
}

/** Merged axis of `a` (moved by `d`) and `b`, with the cell index each side covers there (-1 outside). */
function merge(a, b, d) {
  const out = [], ia = [], ib = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    const v = j >= b.length || (i < a.length && a[i] + d <= b[j]) ? a[i] + d : b[j];
    out.push(v);
    while (i < a.length && a[i] + d <= v) i++;
    while (j < b.length && b[j] <= v) j++;
    ia.push(i > 0 && i < a.length ? i - 1 : -1); ib.push(j > 0 && j < b.length ? j - 1 : -1);
  }
  return { out, ia, ib };
}

/** Pixels of equal colour and pixels drawn by either painting; `a` moves by `[dx, dy]` whole pixels. */
function compareGrids(a, b, [dx, dy]) {
  const X = merge(a.xs, b.xs, dx), Y = merge(a.ys, b.ys, dy);
  let union = 0, same = 0;
  for (let j = 0; j + 1 < Y.out.length; j++) {
    const ay = Y.ia[j], by = Y.ib[j], height = Y.out[j + 1] - Y.out[j];
    for (let i = 0; i + 1 < X.out.length; i++) {
      const p = ay < 0 || X.ia[i] < 0 ? 0 : a.grid[ay * a.w + X.ia[i]];
      const q = by < 0 || X.ib[i] < 0 ? 0 : b.grid[by * b.w + X.ib[i]];
      if (!p && !q) continue;
      const area = (X.out[i + 1] - X.out[i]) * height;
      union += area;
      if (p === q) same += area;
    }
  }
  return { union, same, different: union - same, iou: union ? same / union : null };
}

/** Pixels of equal colour over pixels drawn by either appearance; `a` moves by `[dx, dy]` whole pixels. */
export function compareAppearance(a, b, shift = [0, 0]) {
  const ids = new Map();
  return compareGrids(paint(a, ids), paint(b, ids), shift);
}

const SHIFTS = [-1, 0, 1].flatMap(dx => [-1, 0, 1].map(dy => [dx, dy]));
/** Scores appearances against a fixed `reference`, painted once: plain IoU and the best colour-aware IoU over
 * whole-shape shifts of at most one pixel per axis (null when both are empty). */
export function appearanceScorer(reference, { aimColor = null } = {}) {
  const ids = new Map(), b = paint(reference, ids);
  const aimGrid = p => ({ ...p, grid: p.grid.map(id => id === ids.get(aimColor) ? id : 0) });
  const aimB = aimColor === null ? null : aimGrid(b);
  return layers => {
    const a = paint(layers, ids);
    const aimA = aimB && aimGrid(a);
    let aligned = null, alignedAim = null, aimAlignedAppearance = null, aimShift = null;
    for (const shift of SHIFTS) {
      const { iou } = compareGrids(a, b, shift);
      if (iou !== null && (aligned === null || iou > aligned)) aligned = iou;
      if (aimB) {
        const aim = compareGrids(aimA, aimB, shift).iou;
        if (aim !== null && (alignedAim === null || aim > alignedAim ||
          (aim === alignedAim && iou > aimAlignedAppearance))) {
          alignedAim = aim; aimAlignedAppearance = iou; aimShift = shift;
        }
      }
    }
    return { iou: compareGrids(a, b, [0, 0]).iou, aligned,
      ...(aimB ? { aimIou: compareGrids(aimA, aimB, [0, 0]).iou, alignedAim, aimAlignedAppearance, aimShift } : {}) };
  };
}

/** Best colour-aware IoU over whole-shape shifts of at most one pixel per axis; null when both are empty. */
export const alignedAppearance = (a, b) => appearanceScorer(b)(a).aligned;
