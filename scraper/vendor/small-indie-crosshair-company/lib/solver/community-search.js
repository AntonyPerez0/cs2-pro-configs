/** Finite dimension-first search. Among equally accurate size choices, translation-aligned pixel overlap
 * selects the shape, then raw overlap, then the closest-ideal preference. */
import { communityDimension, communityForward } from '../geometry/community.js';
import { drawingEdges } from '../geometry/raster.js';
import { NATIVE_RANGES_2000922 as RANGES } from '../settings/native.js';
import { communityAxis } from './community-axis.js';
import { visualContext } from './visual.js';

function representatives(solution, ratio) {
  const values = new Map();
  for (const value of [...solution.equivalents].sort((a, b) =>
    Math.abs(a - solution.ideal) - Math.abs(b - solution.ideal) || a - b)) {
    const drawn = communityDimension(value, ratio);
    if (!values.has(drawn)) values.set(drawn, value);
  }
  return [...values.values()];
}

/** `reference` is the visible old shape the ties are scored against when it differs from `target`, drawn with
 * the old flags `referenceFlags` when the exported flags differ. */
export function searchCommunity(target, settings, options, targetMask = null, reference = target, referenceFlags = settings) {
  const ratio = options.currentHeight / options.authoredHeight, edges = drawingEdges(target);
  let axisEvaluations = 0;
  const axis = (wanted, max, minimum = 0) => {
    const { evaluations, ...solution } = communityAxis(wanted, ratio, max, minimum);
    axisEvaluations += evaluations;
    return solution;
  };
  const length = axis(target.length, RANGES.length.max),
    thickness = axis(target.width, RANGES.thickness.max, 1);
  const lengths = representatives(length, ratio), widths = representatives(thickness, ratio);
  const visual = visualContext(reference, settings, targetMask, referenceFlags), branches = [];
  for (const value of widths) {
    const width = communityDimension(value, ratio), radius = (edges.near + edges.far + width % 2) / 2;
    const gap = axis(radius, RANGES.gap.max);
    branches.push({ thickness: value, gap, radius, gaps: representatives(gap, ratio) });
  }
  const originalBranch = branches.find(branch => branch.thickness === thickness.value);
  const initial = { length: length.value, thickness: thickness.value, gap: originalBranch.gap.value,
    authoredHeight: options.authoredHeight };
  const initialGeometry = communityForward(initial, options.currentHeight);
  const beforeIou = visual.score(initialGeometry).iou ?? 0, beforeAligned = visual.aligned(initialGeometry) ?? 0;
  let best = null;
  const shapes = [];
  for (const branch of branches) for (const l of lengths) for (const g of branch.gaps) {
    const native = { length: l, thickness: branch.thickness, gap: g, authoredHeight: options.authoredHeight };
    const predicted = communityForward(native, options.currentHeight), iou = visual.score(predicted).iou ?? 0;
    // The odd-width centring shift moves the whole shape; no cvar removes it, so ties ignore it.
    const aligned = visual.aligned(predicted) ?? 0;
    const edgeLoss = (predicted.near - edges.near) ** 2 + (predicted.far - edges.far) ** 2;
    const preference = [Math.abs(l - length.ideal), l, Math.abs(branch.thickness - thickness.ideal),
      branch.thickness, Math.abs(g - branch.gap.ideal), g];
    const candidate = { native, predicted, iou, aligned, edgeLoss, preference, branch };
    const prefer = best ? preference.findIndex((value, i) => value !== best.preference[i]) : -1;
    // Preserve the previous length/width/gap preference unless pixels actually improve.
    if (!best || aligned > best.aligned || (aligned === best.aligned && (iou > best.iou || (iou === best.iou &&
      prefer >= 0 && preference[prefer] < best.preference[prefer]))))
      best = candidate;
    shapes.push({ native, iou, alignedIou: aligned, edgeLoss });
  }
  const selected = (solution, value) => ({ ...solution, value, tie: Math.abs(value - solution.ideal) });
  return { native: best.native, predicted: best.predicted, radius: best.branch.radius,
    solutions: { length: selected(length, best.native.length), thickness: selected(thickness, best.native.thickness),
      gap: selected(best.branch.gap, best.native.gap) },
    axisEvaluations,
    tieBreak: { baseline: 'closest-ideal-initialization', ranking: 'aligned-iou-then-iou-then-preference',
      evaluated: shapes.length, improved: best.aligned > beforeAligned || (best.aligned === beforeAligned && best.iou > beforeIou),
      beforeIou, afterIou: best.iou, beforeAlignedIou: beforeAligned, afterAlignedIou: best.aligned,
      lengthBranches: lengths.length, widthBranches: widths.length, alternatives: shapes,
      scope: 'Minimum length/width error; closest radius for each tied width; exact overlap, best over whole-shape ' +
        'shifts of at most one pixel, selects the final shape. Not a global pixel optimum over arbitrary dimensions or gaps.' } };
}
