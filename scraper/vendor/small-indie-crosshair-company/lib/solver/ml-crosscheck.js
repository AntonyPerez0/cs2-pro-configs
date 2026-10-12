/** Per-input ML cross-check. Evaluates the exported parameters of a research learner that imitates the
 * automatic converter's export. Independent of the solver: it never calls solveCommunity, searchCommunity,
 * communityAxis or the edge-case planner. Its own source arithmetic builds the old shape, the regime transforms and
 * a bracketing candidate set; learned trees pick among the candidates and predict the appearance keys, and the
 * appearance window, re-derived from geometry helpers, moves the pick as the converter does.
 * Pure: the parameter object is passed in, nothing is fetched. Agreement with our own method, not game accuracy. */
import { COMMUNITY_MODEL, COMMUNITY_REVISION, communityLegacy, communityDimension,
  communityForward, pixelWindow } from '../geometry/community.js';
import { appearance, legacyAppearance, appearanceScorer, visibleRegions } from '../geometry/appearance.js';
import { regionRuns } from '../geometry/region-structure.js';
import { RAW_EDGE_CONVENTION } from '../geometry/raster.js';
import { legacyOutlineExtent, nativeOutlineExtent, outlineMode, outlineChoice, tShapeChoice, rgba, exportFillAlpha,
  effectiveOutlineMode, NATIVE_RANGES_2000922 as RANGES } from '../settings/native.js';
import { hash } from './statistics.js';

export const CROSSCHECK_SCHEMA = 'sicc-ml-crosscheck-v1';
export const INPUT_FEATURES = Object.freeze(['ratio', 'screenGoal', 'factor', 'dot', 'tStyle', 'weaponGap',
  'oldLength', 'oldWidth', 'oldNear', 'oldFar', 'crossing', 'size0Kind', 'zeroLength',
  'targetLength', 'targetWidth', 'targetNear', 'targetFar', 'targetAxisStart',
  'outlineOn', 'outlineWidth', 'outlineRounded', 'outlineLow', 'outlineHigh', 'outlineModeRule',
  'useAlpha', 'crosshairAlpha', 'oldWidthParity', 'targetWidthParity',
  'idealLength', 'idealWidth', 'lengthFraction', 'widthFraction', 'lengthChoices', 'widthChoices', 'candidateCount',
  'stemAbove', 'stemBelow', 'tAlignedApprox', 'plusAlignedApprox', 'plusOverT']);
export const CANDIDATE_FEATURES = Object.freeze(['lengthError', 'widthError', 'nearError', 'farError',
  'drawnWidthParity', 'axisShift', 'axisCellLow', 'axisCellHigh', 'nearCellInner', 'nearCellOuter',
  'farCellInner', 'farCellOuter', 'lengthPreference', 'widthPreference', 'gapPreference', 'order', 'approxIou',
  'approxAlignedIou', 'referenceAlignedIou', 'plusReferenceAlignedIou']);
/** Binary and one-vs-rest heads over the input features. The T flag is not predicted: it is planned from the old T
 * shape and may be moved by the appearance window (ADR-0020). */
export const HEADS = Object.freeze(['drawoutline0', 'drawoutline1', 'drawoutline2', 'outlineAlphaOld', 'colorBlack',
  'fillAlphaOld']);
export const EXPORT_STATE_KEYS = Object.freeze(['length', 'thickness', 'gap', 'authoredHeight', 'drawoutline',
  'outlineAlpha', 'color', 'fillAlpha', 't_style']);
const CROSSING = { none: 0, full: 1, partial: 2, unrepresentable: 3 };
const SIZE0 = { none: 0, dot: 1, outline: 2, empty: 3 };

/** Solid bar through the centre over cells [x0, x1): symmetric (even) or one cell past it (odd centring), moved back
 * by whole pixels when snapped cells sit off the centre. */
function solid(x0, x1, width, axisStart) {
  const k = Math.floor((x0 + x1) / 2);
  return x0 + x1 === 2 * k ? { length: x1 - k, width, near: 0, far: 0, axisStart: axisStart - k }
    : { length: x1 - k, width, near: 0, far: -1, axisStart: axisStart - k - 1 };
}

/**
 * Old shape and the regime transforms, re-derived from source arithmetic (old pixels, drawing edges).
 * Size 0 with a dot becomes arms inside the dot square; size 0 with an outline becomes the outline strokes as a core;
 * arms whose near edge is negative cross the centre and are folded (full) or merged into one bar (partial).
 * `tShape` is the T-shape family of the unfolded old shape (ADR-0020), null without T.
 * @returns {{old: object, shape: object, crossing: string, size0: string, extent: {low: number, high: number},
 *   tShape: ?object}}
 */
export function regimeShape(settings, height) {
  const g = communityLegacy(settings, height), W = g.width;
  // Old renderer: even widths draw the far arm one pixel nearer (illustrative-parity-v2 edges).
  const old = { length: g.length, width: W, near: g.near, far: g.far - (W % 2 === 0 ? 1 : 0), axisStart: 0 - Math.floor(W / 2) };
  const extent = settings.outline === undefined ? { low: 0, high: 0 } : legacyOutlineExtent(settings);
  return { old, extent, ...regimeTransform(old, settings, extent) };
}

/** The regime transforms of one shape (drawing edges, axisStart), in whatever pixels it is given. */
function regimeTransform(old, settings, extent) {
  const W = old.width;
  let shape = old, size0 = 'none', crossing = 'none';
  if (old.length === 0) {
    if (settings.dot) { shape = solid(old.axisStart, old.axisStart + W, W, old.axisStart); size0 = 'dot'; }
    else if (extent.low + extent.high > 0) {
      const { low, high } = extent;
      shape = { length: low + high, width: W + low + high, near: old.near - high, far: old.far - low, axisStart: old.axisStart - low };
      size0 = 'outline';
    } else size0 = 'empty';
  }
  const unfolded = shape, { length: L, near: a, far: b, width, axisStart: t } = shape;
  // The old T stem (bottom arm) spans [b, b + L); a negative near edge puts part of it above the centre.
  const stem = { above: Math.max(0, Math.min(b + L, 0) - b), below: Math.max(0, b + L - Math.max(b, 0)) };
  if (L > 0 && a < 0) {
    crossing = 'unrepresentable';
    if (a + L <= 0 && b + L <= 0) {
      shape = { length: L, width, near: 0 - (b + L), far: 0 - a - L, axisStart: t }; crossing = 'full';
    } else if (!(Math.max(0 - a - L, b) > Math.min(0 - a, b + L))) {
      const merged = solid(Math.min(0 - a - L, b), Math.max(0 - a, b + L), width, t);
      if (merged) { shape = merged; crossing = 'partial'; }
    }
  }
  const tShape = settings.t_style ? tFamily(unfolded, size0, extent.low + extent.high > 0) : null;
  return { shape, unfolded, crossing, size0, stem, tShape };
}

/** T-shape family (ADR-0020), re-derived: the stem `[b, b + L)` against the bar band `[t, t + W)`. Size 0 with an outline
 * (dot or not) drew outline strokes and is `strokes`; other size 0 shapes are `no-effect`. A T can never draw a stem
 * above the bar, so `inverted` and `straddle-symmetric` export a cross. */
function tFamily({ length: L, width: W, far: b, axisStart: t }, size0, outlined) {
  const above = Math.max(0, t - b), below = Math.max(0, b + L - (t + W));
  const family = size0 === 'outline' || (size0 === 'dot' && outlined) ? 'strokes' : size0 !== 'none' || !(L > 0) ? 'no-effect'
    : !above ? (below ? 'upright' : 'stem-hidden') : !below ? 'inverted' : above === below ? 'straddle-symmetric' : 'straddle';
  const flippable = ['strokes', 'inverted', 'straddle', 'straddle-symmetric', 'stem-hidden'].includes(family);
  return { family, flippable, exportT: !['inverted', 'straddle-symmetric'].includes(family) };
}

const transformed = regime => ['full', 'partial'].includes(regime.crossing) || ['dot', 'outline'].includes(regime.size0);
/** Whole cells a fractional shape paints at pixel centres; null when the two arms of an axis differ in length. */
function snapCells(g) {
  const { left: [l0, l1], right: [r0, r1], across: [t0, t1] } = cellEdges(g), width = t1 - t0;
  return l1 - l0 !== r1 - r0 || width < 1 ? null
    : { length: l1 - l0, width, near: 0 - l1, far: r0, axisStart: t0 };
}

/** Minimum-error integer values of one monotone axis, one per drawn pixel (closest to the ideal, then smaller),
 * found by scanning a bracket around the ideal. Independent of lib/solver/community-axis.js. */
export function bracketAxis(wanted, ratio, max, min = 0) {
  const ideal = wanted / ratio, reach = Math.ceil(1 / ratio) + 1;
  const low = Math.max(min, Math.min(max, Math.floor(ideal)) - reach), high = Math.min(max, Math.max(min, Math.ceil(ideal)) + reach);
  let best = Infinity;
  const scanned = [];
  for (let value = low; value <= high; value++) {
    const drawn = communityDimension(value, ratio), loss = (drawn - wanted) ** 2;
    scanned.push({ value, drawn, loss }); if (loss < best) best = loss;
  }
  const chosen = new Map();
  for (const { value, drawn, loss } of scanned) {
    if (loss !== best) continue;
    const current = chosen.get(drawn), distance = Math.abs(value - ideal);
    if (current === undefined || distance < Math.abs(current - ideal)) chosen.set(drawn, value);
  }
  return { ideal, values: [...chosen.values()].sort((p, q) => Math.abs(p - ideal) - Math.abs(q - ideal) || p - q) };
}

const order = (a, b) => {
  const i = a.preference.findIndex((value, k) => value !== b.preference[k]);
  return i < 0 ? 0 : a.preference[i] - b.preference[i];
};
const cell = value => Math.ceil(value - .5);

/** Screen endpoint sampling, independently derived from original integer drawing edges, never from scaled
 * near+length sums. The original pixel-goal/fractional path remains ordinary pixel-centre arithmetic. */
function scaledGeometry(g, factor, oldHeight, currentHeight) {
  const target = { length: g.length * factor, width: g.width * factor, near: g.near * factor, far: g.far * factor,
    axisStart: g.axisStart * factor };
  if (factor !== 1) {
    const source = { length: g.length, width: g.width, near: g.near, far: g.far, axisStart: g.axisStart, oldHeight, currentHeight };
    if (Object.values(source).every(Number.isSafeInteger)) {
      target.screenSource = source; target.rasterConvention = RAW_EDGE_CONVENTION;
      cellEdges(target);
    }
  }
  return target;
}

function cellEdges(g) {
  const source = g.screenSource, { length: L, width: W, near: a, far: b, axisStart: t } = source ?? g;
  const sample = source ? edge => {
    const product = 2 * edge * source.currentHeight, numerator = product - source.oldHeight, divisor = 2 * source.oldHeight;
    if (![edge, product, numerator, divisor].every(Number.isSafeInteger))
      throw new Error('Cross-check screen sampling exceeds safe integer arithmetic.');
    const remainder = numerator % divisor;
    return (numerator - remainder) / divisor + Number(remainder > 0);
  } : cell;
  return { left: [sample(-a - L), sample(-a)], right: [sample(b), sample(b + L)], across: [sample(t), sample(t + W)] };
}

/** Cell boxes `[x0, x1, y0, y1]` of the arms and the dot, painted at pixel centres like the preview raster. */
function boxes(g, flags) {
  const { left, right, across } = cellEdges(g), out = [];
  if (g.length > 0) {
    out.push([...left, ...across], [...right, ...across], [...across, ...right]);
    if (!flags.t_style) out.push([...across, ...left]);
  }
  if (flags.dot) out.push([...across, ...across]);
  return out.filter(([x0, x1, y0, y1]) => x1 > x0 && y1 > y0);
}
const edges = (list, i) => [...new Set(list.flatMap(box => [box[i], box[i + 1]]))].sort((u, v) => u - v);
const inside = (list, x, y) => list.some(([x0, x1, y0, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
/** Exact overlap of the two painted unions (coordinate-compressed cells), with `p` moved by dx, dy. */
function boxIou(p, q, dx = 0, dy = 0) {
  const moved = p.map(([x0, x1, y0, y1]) => [x0 + dx, x1 + dx, y0 + dy, y1 + dy]), all = [...moved, ...q];
  const xs = edges(all, 0), ys = edges(all, 2);
  let shared = 0, union = 0;
  for (let i = 1; i < xs.length; i++) for (let j = 1; j < ys.length; j++) {
    const a = inside(moved, xs[i - 1], ys[j - 1]), b = inside(q, xs[i - 1], ys[j - 1]);
    if (!a && !b) continue;
    const cells = (xs[i] - xs[i - 1]) * (ys[j] - ys[j - 1]);
    union += cells; if (a && b) shared += cells;
  }
  return union > 0 ? shared / union : 1;
}
function alignedBoxIou(p, q) {
  let best = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) best = Math.max(best, boxIou(p, q, dx, dy));
  return best;
}
/** New pixels of a native tuple (community renderer, odd widths centred on -ceil(W/2)). */
function drawnShape(n, ratio) {
  const width = communityDimension(n.thickness, ratio), near = communityDimension(n.gap, ratio);
  return { length: communityDimension(n.length, ratio), width, near, far: near - width % 2, axisStart: 0 - Math.ceil(width / 2) };
}

/** Input features and the bracketing candidates for one input. `options` is a resolved scope (all heights and goal). */
export function crossCheckInput(settings, options) {
  const { oldHeight, currentHeight, authoredHeight, goal } = options;
  const regime = regimeShape(settings, oldHeight), { old, shape, extent } = regime;
  const factor = goal === 'screen' ? currentHeight / oldHeight : 1, ratio = currentHeight / authoredHeight;
  const scaled = g => scaledGeometry(g, factor, oldHeight, currentHeight);
  // A screen goal applies the transforms to the whole current pixels the scaled old shape covers, as the converter does.
  const cells = factor !== 1 && transformed(regime) ? snapCells(scaled(old)) : null;
  const snapped = cells && regimeTransform(cells, settings, extent);
  const target = snapped && transformed(snapped) ? snapped.shape : scaled(shape);
  const length = bracketAxis(target.length, ratio, RANGES.length.max), width = bracketAxis(target.width, ratio, RANGES.thickness.max, 1);
  const candidates = [];
  for (const thickness of width.values) {
    const drawnWidth = communityDimension(thickness, ratio), gap = bracketAxis((target.near + target.far + drawnWidth % 2) / 2,
      ratio, RANGES.gap.max);
    for (const l of length.values) for (const g of gap.values) candidates.push({
      native: { length: l, thickness, gap: g, authoredHeight },
      preference: [Math.abs(l - length.ideal), l, Math.abs(thickness - width.ideal), thickness, Math.abs(g - gap.ideal), g] });
  }
  candidates.sort(order);
  // Plus against T for the first candidate, both against the unfolded old shape drawn with the old flags.
  const flags = { dot: !!settings.dot, t_style: !!settings.t_style }, reference = boxes(scaled(regime.unfolded), flags);
  const first = drawnShape(candidates[0].native, ratio), versus = t_style => alignedBoxIou(boxes(first, { ...flags, t_style }), reference);
  const keepT = versus(true), plus = versus(false);
  const outlineOn = Number(!!settings.outline), alpha = rgba(settings).alpha;
  const features = [ratio, Number(goal === 'screen'), factor, Number(!!settings.dot), Number(!!settings.t_style),
    Number(!!settings.weapon_gap), old.length, old.width, old.near, old.far, CROSSING[regime.crossing], SIZE0[regime.size0],
    Number(settings.size > 0 && old.length === 0), target.length, target.width, target.near, target.far, target.axisStart,
    outlineOn, outlineOn ? settings.outline_width ?? 1 : 0, Number(!!settings.outline_width_rounded), extent.low, extent.high,
    settings.outline === undefined ? 0 : outlineMode(settings), Number(!!settings.alpha_enabled), alpha, old.width % 2,
    shape.width % 2, length.ideal, width.ideal, length.ideal - Math.floor(length.ideal), width.ideal - Math.floor(width.ideal),
    length.values.length, width.values.length, candidates.length, regime.stem.above * factor, regime.stem.below * factor,
    keepT, plus, plus - keepT];
  return { features, candidates, target, ratio, regime, flags, reference, length, width };
}

/** Candidate features: drawn new shape against the target, pixel-cell edges and the closest-ideal preference. */
export function candidateFeatures(input, candidate, index) {
  const { target: t, ratio, flags, reference } = input, { native: n, preference } = candidate, shape = drawnShape(n, ratio);
  const { length, width, near, far, axisStart: axis } = shape, drawn = boxes(shape, flags), old = boxes(t, flags);
  const targetCells = cellEdges(t), drawnCells = cellEdges(shape);
  return [length - t.length, width - t.width, near - t.near, far - t.far, width % 2, axis - t.axisStart,
    drawnCells.across[0] - targetCells.across[0], drawnCells.across[1] - targetCells.across[1],
    drawnCells.left[1] - targetCells.left[1], drawnCells.left[0] - targetCells.left[0],
    drawnCells.right[0] - targetCells.right[0], drawnCells.right[1] - targetCells.right[1],
    preference[0], preference[2], preference[4], index, boxIou(drawn, old), alignedBoxIou(drawn, old),
    alignedBoxIou(drawn, reference), alignedBoxIou(boxes(shape, { ...flags, t_style: false }), reference)];
}

/** The T flag the `on` and `off` choices force, else undefined. */
const forcedT = choice => choice === 'on' ? true : choice === 'off' ? false : undefined;

/** Independent visible-dot eligibility: final fill cells occupy one complete square, distinct from outline ink.
 * Shares only low-level compositing, not the runtime taxonomy, edge planner or objective implementation. */
function mirrorScorer(layers, color, distinct) {
  const cells = distinct ? visibleRegions(layers).filter(r => r.color === color) : [];
  const area = cells.reduce((n, r) => n + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  const width = Math.max(...cells.map(r => r.x1)) - Math.min(...cells.map(r => r.x0));
  const height = Math.max(...cells.map(r => r.y1)) - Math.min(...cells.map(r => r.y0));
  return appearanceScorer(layers, { aimColor: area > 0 && width === height && area === width * height ? color : null });
}
function mirrorCompare(a, b) {
  if (a.alignedAim !== undefined && Math.abs((a.alignedAim ?? -1) - (b.alignedAim ?? -1)) > 1e-9)
    return (a.alignedAim ?? -1) - (b.alignedAim ?? -1);
  const x = a.alignedAim === undefined ? a.aligned : a.aimAlignedAppearance;
  const y = b.alignedAim === undefined ? b.aligned : b.aimAlignedAppearance;
  return Math.abs((x ?? -1) - (y ?? -1)) > 1e-9 ? (x ?? -1) - (y ?? -1) : 0;
}

/** Independently invert visible stroke dimensions by scanning native axes. Only compositing/run extraction
 * is shared with the converter; no search, taxonomy, candidate or inverse-axis solver is imported. */
function mirrorStrokeCandidates(layers, input, core, gapIdeal) {
  const cells = visibleRegions(layers), groups = [cells];
  for (const color of new Set(cells.map(r => r.color))) groups.push(cells.filter(r => r.color === color));
  const { ratio } = input, cache = new Map(), out = new Map();
  const nearest = (wanted, key, min, ideal) => {
    const id = `${wanted},${key},${min},${ideal}`;
    if (cache.has(id)) return cache.get(id);
    const values = new Map();
    for (const offset of [-1, 0, 1]) {
      const target = Math.max(min, wanted + offset), choices = [];
      let loss = Infinity;
      for (let v = min; v <= RANGES[key].max; v++) {
        const drawn = communityDimension(v, ratio), error = (drawn - target) ** 2;
        if (error < loss) { choices.length = 0; loss = error; }
        if (error === loss) choices.push([v, drawn]);
      }
      for (const [v, drawn] of choices) {
        const prior = values.get(drawn);
        if (prior === undefined || Math.abs(v - ideal) < Math.abs(prior - ideal)) values.set(drawn, v);
      }
    }
    cache.set(id, [...values.values()]);
    return cache.get(id);
  };
  for (const group of groups) for (const rect of [...regionRuns(group), ...regionRuns(group, true)]) {
    for (const [span, breadth, lo, hi] of [[rect.x1 - rect.x0, rect.y1 - rect.y0, rect.x0, rect.x1],
      [rect.y1 - rect.y0, rect.x1 - rect.x0, rect.y0, rect.y1]]) {
      const centre = lo <= 0 && hi >= 0;
      for (const thickness of nearest(breadth, 'thickness', 1, input.width.ideal)) {
        const gaps = [lo + communityDimension(thickness, ratio) % 2, -hi, ...(centre ? [0] : [])];
        for (const edge of gaps.filter(g => g >= 0))
          for (const gap of nearest(edge, 'gap', 0, gapIdeal(thickness)))
            for (const size of [span, ...(centre ? [Math.ceil(span / 2)] : [])])
              for (const length of nearest(size, 'length', core.length > 0 ? 1 : 0, input.length.ideal))
                out.set(`${length},${thickness},${gap}`, { length, thickness, gap });
      }
    }
  }
  return [...out.values()];
}

/**
 * The appearance window, re-derived from geometry helpers (no solver code): at either goal, with an old
 * outline of any width, a core whose colour-aware look is neither exact nor exact after a 1 px shift moves
 * to the best tuple drawing within ±3 px of bar length, ±3 px of bar width and ±4 px of the gap edge (current pixels,
 * mapped to native values by the authored/current ratio, or as many native steps where that reaches further) that
 * improves the selected objective (visible square core first, then appearance at its shift). The gap window reaches
 * as far as the old shape's own inner edges plus 2 px (with
 * a dot, the dot's outline edge, ceil(width / 2) + 2 px), at most 32 px and never below 4; for every gap a second
 * length window (±3) keeps the outer edge of the bars where the pick put it; the bar width window reaches as far,
 * capped at 8, when that is more than 3 (ADR-0019). With the T option `auto` the window starts from the planned T flag
 * of the old T shape (`regime.tShape.exportT`, ADR-0020) and a flippable shape also tries every tuple with the other
 * flag, which must beat the best planned one outright; `keep` (default) starts from the old flag, `on` and `off` from
 * the forced one, and neither tries another flag (ADR-0025). `tStyle` is the old T flag. Returns `core` with `tStyle`, the exported T flag
 * (the planned one out of scope or when nothing moves), or the pick with its flag.
 */
export function appearanceWindow(settings, options, input, core, tStyle, cache = new Map()) {
  const { extent, size0, tShape } = input.regime, choice = tShapeChoice(options.tShape);
  const planned = choice === 'auto' && tShape ? tShape.exportT : forcedT(choice) ?? tStyle, kept = { ...core, tStyle: planned };
  if (settings.outline === undefined) return kept;
  const { rgb, alpha } = rgba(settings), key = c => `${c.join(',')},${alpha}`, black = key([0, 0, 0]);
  if (alpha === 0) return kept;
  const { oldHeight, currentHeight } = options, factor = options.goal === 'screen' ? currentHeight / oldHeight : 1;
  const old = { ...scaledGeometry(input.regime.old, factor, oldHeight, currentHeight),
    rasterConvention: RAW_EDGE_CONVENTION };
  const referenceLayers = legacyAppearance(old, settings, extent, { core: key(rgb), outline: black });
  const score = mirrorScorer(referenceLayers, key(rgb),
    alpha > 0 && (key(rgb) !== black || extent.low + extent.high === 0));
  // Size 0 drawing only outline strokes exports black bars with the outline off.
  const look = { core: size0 === 'outline' ? black : key(rgb), outline: black };
  const mode = size0 === 'outline' && outlineChoice(options.outlineMode) === 'auto'
    ? 0 : effectiveOutlineMode(settings, options.outlineMode);
  const drawn = nativeOutlineExtent(settings, mode);
  const dot = !!settings.dot;
  const evaluate = (n, t = planned) => {
    const g = communityForward({ ...n, authoredHeight: options.authoredHeight }, options.currentHeight);
    const id = `${g.length},${g.width},${g.near},${t}`;
    if (!cache.has(id)) cache.set(id, score(appearance(g, { dot, t_style: t }, drawn, look, false)));
    return cache.get(id);
  };
  const start = evaluate(core);
  if (start.iou === null || start.aligned === 1) return kept;
  const { target: t, ratio, length, width } = input;
  const gapIdeal = thickness => (t.near + t.far + communityDimension(thickness, ratio) % 2) / 2 / ratio;
  const preference = n => [Math.abs(n.length - length.ideal), n.length, Math.abs(n.thickness - width.ideal), n.thickness,
    Math.abs(n.gap - gapIdeal(n.thickness)), n.gap];
  const minLength = core.length > 0 ? 1 : 0, lengthWindow = centre => pixelWindow(
    Math.max(minLength, Math.min(RANGES.length.max, centre)), 3, ratio, minLength, RANGES.length.max, length.ideal);
  const lengths = lengthWindow(core.length);
  const reach = Math.min(32, Math.max(4, Math.ceil(Math.max(Math.abs(old.near), Math.abs(old.far))) + 2,
    settings.dot ? Math.ceil(old.width / 2) + 2 : 0));
  let best = null;
  const thicknesses = pixelWindow(core.thickness, Math.max(3, Math.min(8, reach)), ratio, 1, RANGES.thickness.max, width.ideal);
  const proposals = mirrorStrokeCandidates(referenceLayers, input, core, gapIdeal);
  for (const flip of choice === 'auto' && tShape?.flippable ? [planned, !planned] : [planned]) {
    const floor = flip === planned || !best ? start : best.s;
    const consider = n => {
      const s = evaluate(n, flip);
      if (s.aligned === null || mirrorCompare(s, floor) <= 0) return;
      const comparison = best ? mirrorCompare(s, best.s) : 1;
      if (best && (comparison < 0 || (comparison === 0 && s.iou < best.s.iou))) return;
      if (best && comparison === 0 && s.iou === best.s.iou) {
        const a = preference(n), b = preference(best.n), i = a.findIndex((v, k) => v !== b[k]);
        if (i < 0 || a[i] > b[i]) return;
      }
      best = { n, s, t: flip };
    };
    for (const th of thicknesses) {
      const gaps = pixelWindow(core.gap, reach, ratio, RANGES.gap.min, RANGES.gap.max, gapIdeal(th));
      for (const g of gaps)
        for (const l of new Set([...lengths, ...lengthWindow(core.length + core.gap - g)])) {
          consider({ length: l, thickness: th, gap: g });
        }
    }
    for (const proposal of proposals) consider(proposal);
  }
  return best ? { ...core, ...best.n, tStyle: best.t } : kept;
}

/**
 * The plain-conversion fallback, re-derived from geometry helpers: when a regime transform or
 * the window shaped the pick, the plain conversion of the untransformed old shape (closest candidates, ties by
 * shift-aligned core overlap, then raw overlap, then the preference order) replaces it if it draws the old look,
 * under the same visible-aim/appearance objective, strictly better. `picked` is the windowed core, `core` the ranker's.
 */
export function plainFallback(settings, options, input, core, picked, tStyle) {
  const { regime, ratio } = input, pickedT = picked.tStyle ?? tStyle, plainT = forcedT(tShapeChoice(options.tShape)) ?? tStyle;
  const moved = ['length', 'thickness', 'gap'].some(key => picked[key] !== core[key]) || pickedT !== tStyle;
  if (settings.outline === undefined || (!transformed(regime) && !moved)) return picked;
  if (rgba(settings).alpha === 0) return picked;
  const { oldHeight, currentHeight, authoredHeight, goal } = options, factor = goal === 'screen' ? currentHeight / oldHeight : 1;
  const old = regime.old, target = scaledGeometry(old, factor, oldHeight, currentHeight);
  // The plain path keeps the old flag unless the T option forces one; the reference is always the old shape.
  const flags = { dot: !!settings.dot, t_style: plainT }, reference = boxes(target, { ...flags, t_style: tStyle });
  const length = bracketAxis(target.length, ratio, RANGES.length.max), width = bracketAxis(target.width, ratio, RANGES.thickness.max, 1);
  let plain = null;
  for (const thickness of width.values) {
    const gap = bracketAxis((target.near + target.far + communityDimension(thickness, ratio) % 2) / 2, ratio, RANGES.gap.max);
    for (const l of length.values) for (const g of gap.values) {
      const drawn = boxes(drawnShape({ length: l, thickness, gap: g }, ratio), flags), union = drawn.length + reference.length;
      const c = { native: { length: l, thickness, gap: g }, aligned: union ? alignedBoxIou(drawn, reference) : 0,
        iou: union ? boxIou(drawn, reference) : 0,
        preference: [Math.abs(l - length.ideal), l, Math.abs(thickness - width.ideal), thickness, Math.abs(g - gap.ideal), g] };
      if (!plain || c.aligned > plain.aligned || (c.aligned === plain.aligned && (c.iou > plain.iou ||
        (c.iou === plain.iou && order(c, plain) < 0)))) plain = c;
    }
  }
  const { rgb, alpha } = rgba(settings), key = c => `${c.join(',')},${alpha}`, black = key([0, 0, 0]);
  const score = mirrorScorer(legacyAppearance({ ...target, rasterConvention: RAW_EDGE_CONVENTION }, settings,
    regime.extent, { core: key(rgb), outline: black }), key(rgb),
    alpha > 0 && (key(rgb) !== black || regime.extent.low + regime.extent.high === 0));
  const choice = outlineChoice(options.outlineMode), automatic = effectiveOutlineMode(settings, options.outlineMode);
  // Size 0 drawing only outline strokes exports black bars, outline off unless chosen by hand.
  const strokes = transformed(regime) && regime.size0 === 'outline';
  const look = (n, black0, mode, t = plainT) => score(appearance(communityForward({ ...n, authoredHeight }, currentHeight),
    { ...flags, t_style: t },
    nativeOutlineExtent(settings, mode), { core: black0 ? black : key(rgb), outline: black }, false));
  const before = look(picked, strokes, strokes && choice === 'auto' ? 0 : automatic, pickedT);
  const after = look(plain.native, false, automatic);
  return mirrorCompare(after, before) > 0 ? { ...picked, ...plain.native, tStyle: plainT } : picked;
}

const evaluateNode = (node, x) => typeof node === 'number' ? node : x[node[0]] <= node[1] ? evaluateNode(node[2], x)
  : evaluateNode(node[3], x);
/** Same summation order as the research trainer's boosted-tree scorer, so scores agree bit for bit. */
export function scoreTrees(block, learningRate, x) {
  let value = block.base;
  for (const tree of block.trees) value += learningRate * evaluateNode(tree, x);
  return value;
}

/** The learner's predicted export state for one input. A hand-chosen outline mode is copied, not predicted. */
export function predictCrossCheck(params, settings, options) {
  const input = crossCheckInput(settings, options), x = input.features;
  let best = input.candidates[0];
  if (input.candidates.length > 1) {
    let top = -Infinity;
    input.candidates.forEach((candidate, i) => {
      const score = scoreTrees(params.ranker, params.ranker.learningRate, [...x, ...candidateFeatures(input, candidate, i)]);
      if (score > top) { top = score; best = candidate; }
    });
  }
  const head = name => scoreTrees(params.heads.outputs[name], params.heads.learningRate, x);
  const modes = [0, 1, 2].map(mode => head(`drawoutline${mode}`));
  const learnedMode = modes.indexOf(Math.max(...modes)), choice = outlineChoice(options.outlineMode);
  const old = rgba(settings), black = head('colorBlack') > .5, mode = choice === 'auto' ? learnedMode : choice;
  const outlineAlpha = choice === 'auto' ? (head('outlineAlphaOld') > .5 ? old.alpha : 255) : mode ? old.alpha : 255;
  const tStyle = !!settings.t_style;
  const picked = appearanceWindow(settings, options, input, best.native, tStyle);
  const { tStyle: exportedT = tStyle, ...tuple } = plainFallback(settings, options, input, best.native, picked, tStyle);
  return { ...tuple, drawoutline: mode, outlineAlpha, color: (black ? [0, 0, 0] : old.rgb).join(' '),
    fillAlpha: head('fillAlphaOld') > .5 ? old.alpha : 255, t_style: exportedT };
}

/** The converter's export state, read from a community report the same way nativeCommands formats it. */
export function converterExportState(report) {
  const o = report.exportOverrides ?? {}, settings = report.settings, base = rgba(settings);
  const mode = effectiveOutlineMode(settings, o.outlineMode ?? report.options.outlineMode);
  const alpha = o.color === undefined ? base.alpha : o.color.alpha;
  return { ...report.chosen.native, drawoutline: mode, outlineAlpha: mode ? alpha : 255,
    color: (o.color?.rgb ?? base.rgb).join(' '), fillAlpha: o.color === undefined ? exportFillAlpha(settings) : alpha,
    t_style: !!(o.t_style ?? settings.t_style) };
}

const fingerprints = new WeakMap();
/** FNV-1a of the canonical parameter JSON; detects a parameter file edited or mixed with another release. */
export function parametersHash(params) {
  if (!fingerprints.has(params)) fingerprints.set(params, hash(JSON.stringify({ schema: params.schema,
    targetVersion: params.targetVersion, targetRevision: params.targetRevision,
    featureNames: params.featureNames, ranker: params.ranker, heads: params.heads })));
  return fingerprints.get(params);
}

/** `current` when the parameters were trained for the shipped converter and are intact, else the stale reason. */
export function parameterStatus(params, summary = null) {
  if (!params || params.schema !== CROSSCHECK_SCHEMA) return 'missing';
  if (params.targetVersion !== COMMUNITY_MODEL.version || params.targetBuild !== COMMUNITY_MODEL.build) return 'stale-version';
  if (params.targetRevision !== COMMUNITY_REVISION) return 'stale-revision';
  if (JSON.stringify(params.featureNames) !== JSON.stringify({ input: INPUT_FEATURES, candidate: CANDIDATE_FEATURES, heads: HEADS }))
    return 'stale-features';
  if (parametersHash(params) !== params.parametersHash) return 'stale-hash';
  if (summary && (summary.targetVersion !== params.targetVersion || summary.targetRevision !== params.targetRevision ||
    summary.parametersHash !== params.parametersHash))
    return 'stale-summary';
  return 'current';
}

/** Compare the learner with the converter on one community report. The learner imitates the corrected converter, so
 * a report with the automatic appearance corrections off is not checked (`corrections-off`). */
export function crossCheck(params, report, summary = null) {
  if (report.options?.corrections === false) return { status: 'corrections-off' };
  const status = parameterStatus(params, summary);
  if (status !== 'current') return { status };
  const predicted = predictCrossCheck(params, report.settings, report.options), converter = converterExportState(report);
  const differs = EXPORT_STATE_KEYS.filter(key => predicted[key] !== converter[key]);
  return { status: differs.length ? 'differs' : 'agrees', predicted, converter, differs };
}
