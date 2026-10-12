/** Old shapes the new renderer cannot draw literally, re-expressed as ordinary arms.
 * Every result is a RAW_EDGE_CONVENTION target; `shift` is the whole-shape move `[dx, dy]` from the old
 * mask to the target mask (non-zero only for the odd-width centring of a solid centre). */
import { drawingEdges, RAW_EDGE_CONVENTION, axisStartOf, geometryCellEdges } from './raster.js';

// Re-exported: community.js, ml-crosscheck tests and research import it from here.
export { axisStartOf };

const raw = (g, length, width, near, far, axisStart) => {
  const { screenSource: previous, ...plain } = g;
  return { ...plain, length, width, near, far, axisStart,
    interval: length > 0 ? near + far : null, rasterConvention: RAW_EDGE_CONVENTION };
};
/** Solid bar through the centre over cells `[x0, x1)`: symmetric (even) or one cell past it (odd centring). Old
 * pixels are always centred so; cells snapped from a scaled shape may sit `k` whole pixels off and are moved back. */
function solidCentre(g, x0, x1, width, axisStart) {
  const k = Math.floor((x0 + x1) / 2);
  if (x0 + x1 === 2 * k) return { target: raw(g, x1 - k, width, 0, 0, axisStart - k), shift: [0 - k, 0 - k] };
  return { target: raw(g, x1 - k, width, 0, -1, axisStart - k - 1), shift: [-1 - k, -1 - k] };
}

/** Old arms start at their near edge, so a negative near edge crosses the centre (issue #15).
 * `full`: both arms lie past the centre, mirrored with identical pixels. `partial`: the two arms of an axis
 * merge into one solid bar through the centre. `none`: no crossing, or a union the arms cannot express.
 * With T style the vertical axis is the old stem only, not two arms: the fold still treats it as two, and the
 * planner (`tShape`) sets the exported T flag (ADR-0020). */
export function foldCrossedArms(g) {
  const { near: a, far: b } = drawingEdges(g), L = g.length, t = axisStartOf(g);
  const none = { kind: 'none', target: g, shift: [0, 0] };
  if (!(L > 0) || a >= 0) return none;
  if (a + L <= 0 && b + L <= 0) return { kind: 'full', target: raw(g, L, g.width, 0 - (b + L), 0 - a - L, t), shift: [0, 0] };
  if (Math.max(0 - a - L, b) > Math.min(0 - a, b + L)) return none;
  return { kind: 'partial', ...solidCentre(g, Math.min(0 - a - L, b), Math.max(0 - a, b + L), g.width, t) };
}

/** Size 0 with an outline and no dot drew only the outlines of zero-length bars (issue #11). The same pixels
 * as a coloured core: length low+high, thickness W+low+high, edges and axis moved by the outline extent. */
export function outlineAsCore(g, { low, high }) {
  const { near: a, far: b } = drawingEdges(g);
  return { target: raw(g, low + high, g.width + low + high, a - high, b - low, axisStartOf(g) - low), shift: [0, 0] };
}

/** The whole pixels a fractional raw-edge target paints (pixel centres, as the preview raster), as an integer
 * raw-edge target, so a screen goal can apply the rules above in current pixels; null when the two arms of an axis
 * cover different lengths or the bars cover no column. */
export function snapToCells(g) {
  const { left: [l0, l1], right: [r0, r1], across: [t0, t1] } = geometryCellEdges(g), width = t1 - t0;
  const left = l1 - l0, right = r1 - r0;
  return left !== right || width < 1 ? null : raw(g, left, width, 0 - l1, r0, t0);
}

/** Size 0 with a dot: arms at gap 0 whose union with the dot is exactly the dot's W x W square. */
export function dotAsArms(g) {
  const W = g.width, t = axisStartOf(g);
  return solidCentre(g, t, t + W, W, t);
}

/** How far the old T stem `[b, b + L)` reaches past the horizontal bar band `[t, t + W)`, in whole pixels:
 * `above` from the bar's top edge up to the stem's top, `below` from the bar's bottom edge down to the stem's end
 * (gap included). The old T keeps the code's bottom bar (the leak has no T; ADR-0020), so with the old gap offset d
 * `above = max(0, -W - d)` and `below = max(0, d + L)`. */
export function tStem(g) {
  const { far: b } = drawingEdges(g), t = axisStartOf(g);
  return { above: Math.max(0, t - b), below: Math.max(0, b + g.length - (t + g.width)) };
}

/** T-shape family of the literal old geometry `g` (ADR-0020), null without T. With arms (L > 0): `upright` (stem
 * below the bar), `stem-hidden` (stem inside the bar), `straddle` (through the bar, unequal), `straddle-symmetric`
 * (equally far above and below: it looked like a full cross), `inverted` (stem above the bar). Length 0 with an
 * outline: `strokes`, with or without a dot, since zero-length bars kept their outline and T drops the top stroke
 * (`crossed` when the strokes crossed); length 0 without one: `no-effect` (T changes no pixel). `exportT` is the
 * planned exported flag: a T can never draw a stem above the bar, and a cross's top arm is the old stem.
 * `flippable`: the appearance window also tries the other flag (strict gain). */
export function tShape(g, settings, extent) {
  if (!settings.t_style) return null;
  const shape = (family, stem, flippable, crossed = false) => ({ family, above: stem.above, below: stem.below, flippable,
    crossed, exportT: !['inverted', 'straddle-symmetric'].includes(family) });
  if (!(g.length > 0)) {
    if (!(g.width > 0 && extent.low + extent.high > 0)) return shape('no-effect', { above: 0, below: 0 }, false);
    const strokes = outlineAsCore(g, extent).target;
    return shape('strokes', tStem(strokes), true, foldCrossedArms(strokes).kind !== 'none');
  }
  const { above, below } = tStem(g);
  // A hidden stem drew no T, so a cross may draw the old pixels better; an upright T keeps T.
  if (!above) return shape(below ? 'upright' : 'stem-hidden', { above, below }, !below);
  if (!below) return shape('inverted', { above, below }, true);
  return shape(above === below ? 'straddle-symmetric' : 'straddle', { above, below }, true);
}
