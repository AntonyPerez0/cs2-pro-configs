/** Bounded appearance refinement after the dimension-first choice. Visible solid-square aiming cores
 * rank core overlap first, then full appearance at the same whole-shape shift; other shapes rank full appearance.
 * A neighbour replaces the choice only on a strict objective gain. Exact full-appearance matches stay unchanged. */
import { communityDimension, communityForward, pixelWindow } from '../geometry/community.js';
import { drawingEdges } from '../geometry/raster.js';
import { aimShapeObjective, compareAimScores } from './aim-shape.js';
import { NATIVE_RANGES_2000922 as RANGES } from '../settings/native.js';
import { communityAxis } from './community-axis.js';
import { exportedAppearance, oldAppearance } from './community-edge.js';
import { visibleCandidates } from './visible-candidates.js';

/** Drawn current pixels around the dimension-first choice: bar length, bar width and the gap (inner) edge. Each is
 * mapped to native values by the authored/current ratio (`pixelWindow`), clamped to the native ranges; above ratio 1
 * the same number of native steps reaches further and is kept. `gap` is the minimum reach: the gap window grows to the
 * old shape's own inner edges (see `gapReach`), and the report carries the reach used. */
export const REFINE_WINDOW = Object.freeze({ length: 3, thickness: 3, gap: 4, unit: 'drawn-current-pixels-or-native-steps' });
/** Cap of the gap reach, in drawn current pixels. */
const REFINE_REACH_MAX = 32;
/** Cap of the bar-width reach: wider swaps cost more than they return (ADR-0019; the trainer runs this window per candidate). */
const REFINE_THICKNESS_REACH_MAX = 8;
const SCOPE = 'Pixel or screen goal, any old outline width. Native tuples that draw within ±3 px of bar length, ' +
  '±3 px of bar width and within `reach` px of the gap edge of the dimension-first choice, in current pixels, or lie ' +
  'within as many native steps when that reaches further (thickness at least 1, length at least 1 when the choice ' +
  'draws arms). The reach is at least 4 and extends to the old shape\'s own inner edges plus 2 px (with a dot, to the ' +
  'dot outline edge plus 2 px), at most 32; the bar width window uses the same reach ' +
  'capped at 8 when larger than 3. For every gap a second length window (±3) keeps the outer edge of the bars where the choice ' +
  'put it. An old T whose stem stuck out above the bar, or whose outline strokes crossed, also tries every tuple with ' +
  'the other T flag; it must beat the planned flag strictly (ADR-0020). ' +
  'Visible dot cores prioritize core overlap, then appearance at the same shift; other shapes use colour-aware ' +
  'appearance overlap. Whole-shape shifts are at most one pixel. Applied only when this objective improves; ' +
  'total appearance coverage may decrease to preserve the aiming dot. Also fits visible stroke lengths, widths and ' +
  'inner edges, including ±1 px neighbours and solid-centre proposals, beyond the local window. Not a global optimum.';
/** Gap reach in drawn current pixels: the old shape's literal inner edges (`drawingEdges(target)`) plus 2 px and, with
 * a dot, the dot's outline edge (half its width rounded up, plus 2 px); at least `REFINE_WINDOW.gap`, at most 32. */
const gapReach = (target, dot) => {
  const edges = drawingEdges(target);
  return Math.min(REFINE_REACH_MAX, Math.max(REFINE_WINDOW.gap, Math.ceil(Math.max(Math.abs(edges.near), Math.abs(edges.far))) + 2,
    dot ? Math.ceil(target.width / 2) + 2 : 0));
};
const selected = (solution, value) => ({ ...solution, value, tie: Math.abs(value - solution.ideal) });

/**
 * @param {object} solved - `searchCommunity` result with its exported `flags`.
 * @param {{settings: object, target: object, canonical: object, overrides: object, options: object, plan: object}} context -
 *   `target` the scaled old geometry `shapeCheck` draws, `canonical` the fitted target, `overrides` the export
 *   overrides (colour, outline mode), `plan` the edge-case plan: with `options.tShape` `auto` a flippable T shape
 *   (`plan.tShape.flippable`) also
 *   tries every tuple with the other T flag than the planned one in `solved.flags`, and the result's `flags` carry the
 *   chosen T flag (ADR-0020).
 * @returns {object} `solved` with the refined native tuple, prediction and solutions, plus `refinement`.
 */
export function refineAppearance(solved, { settings, target, canonical, overrides, options, plan }) {
  const { flags, native: initial } = solved, objective = aimShapeObjective(settings, target), { score } = objective;
  const cache = new Map(), evaluate = (native, t = flags.t_style) => {
    const converted = communityForward(native, options.currentHeight);
    const key = `${converted.length},${converted.width},${converted.near},${t}`;
    if (!cache.has(key)) cache.set(key, score(exportedAppearance({ settings, flags: { ...flags, t_style: t }, converted,
      overrides, options })));
    return { native, converted, t, ...cache.get(key) };
  };
  const start = evaluate(initial);
  const reach = gapReach(target, flags.dot), window = { length: REFINE_WINDOW.length, thickness: REFINE_WINDOW.thickness,
    gap: REFINE_WINDOW.gap, reach, outerEdge: true, unit: REFINE_WINDOW.unit };
  // ADR-0020: with the T option `auto`, a T whose old stem stuck out above the bar (or whose strokes crossed) also tries the
  // other T flag; keep, on and off try only the exported one (ADR-0025).
  const flips = options.tShape === 'auto' && plan?.tShape?.flippable ? [flags.t_style, !flags.t_style] : [flags.t_style];
  const report = (applied, after, skipped = null) => ({ applied, skipped, initial,
    before: { iou: start.iou, alignedIou: start.aligned }, after: { iou: after.iou, alignedIou: after.aligned },
    objective: objective.rule, beforeObjective: start, afterObjective: after,
    appearanceTradeoff: after.aligned < start.aligned - 1e-9,
    evaluated: cache.size, window, scope: SCOPE });
  if (start.iou === null || start.aligned === 1)
    return { ...solved, refinement: report(false, start, start.iou === null ? 'empty' : start.iou === 1 ? 'exact' : 'shifted') };
  const ratio = options.currentHeight / options.authoredHeight, edges = drawingEdges(canonical);
  const radius = thickness => (edges.near + edges.far + communityDimension(thickness, ratio) % 2) / 2;
  const { length, thickness } = solved.solutions;
  const preference = n => [Math.abs(n.length - length.ideal), n.length, Math.abs(n.thickness - thickness.ideal),
    n.thickness, Math.abs(n.gap - radius(n.thickness) / ratio), n.gap];
  // One native value per drawn size, the one the preference order would pick among equal shapes.
  const minLength = initial.length > 0 ? 1 : 0, lengthWindow = centre => pixelWindow(
    Math.max(minLength, Math.min(RANGES.length.max, centre)), REFINE_WINDOW.length, ratio, minLength, RANGES.length.max, length.ideal);
  const lengths = lengthWindow(initial.length);
  // For every gap a second length window keeps the outer edge of the bars where the first choice put it.
  let best = null;
  const thicknesses = pixelWindow(initial.thickness, Math.max(REFINE_WINDOW.thickness, Math.min(REFINE_THICKNESS_REACH_MAX, reach)),
    ratio, 1, RANGES.thickness.max,
    thickness.ideal);
  const proposals = visibleCandidates(oldAppearance(settings, target), ratio, initial,
    { length: length.ideal, thickness: thickness.ideal, gap: t => radius(t) / ratio });
  window.visibleStrokeProposals = proposals.length;
  for (const flip of flips) {
    // The other flag must beat the best planned one outright, so a tie keeps the plan.
    const floor = flip === flags.t_style || !best ? start : best;
    const consider = native => {
      const c = evaluate(native, flip);
      if (c.aligned === null || compareAimScores(c, floor) <= 0) return;
      const comparison = best ? compareAimScores(c, best) : 1;
      if (best && (comparison < 0 || (comparison === 0 && c.iou < best.iou))) return;
      if (best && comparison === 0 && c.iou === best.iou) {
        const a = preference(c.native), b = preference(best.native), i = a.findIndex((v, k) => v !== b[k]);
        if (i < 0 || a[i] > b[i]) return;
      }
      best = c;
    };
    for (const t of thicknesses) {
      const gaps = pixelWindow(initial.gap, reach, ratio, RANGES.gap.min, RANGES.gap.max, radius(t) / ratio);
      for (const g of gaps)
        for (const l of new Set([...lengths, ...lengthWindow(initial.length + initial.gap - g)])) {
          consider({ ...initial, length: l, thickness: t, gap: g });
        }
    }
    for (const proposal of proposals) consider(proposal);
  }
  if (!best) return { ...solved, refinement: report(false, start) };
  const gap = communityAxis(radius(best.native.thickness), ratio, RANGES.gap.max);
  delete gap.evaluations;
  return { ...solved, flags: { ...flags, t_style: best.t }, native: best.native, predicted: best.converted,
    radius: radius(best.native.thickness),
    solutions: { length: selected(length, best.native.length), thickness: selected(thickness, best.native.thickness),
      gap: selected(gap, best.native.gap) }, refinement: { ...report(true, best), tStyle: best.t } };
}
