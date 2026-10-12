/** Visible shape identity, separate from the cvars/mechanisms that produced it. No native-renderer claim. */
import { appearance, legacyAppearance, visibleRegions } from './appearance.js';
import { drawingEdges, geometryCellEdges } from './raster.js';
import { foldCrossedArms, tShape } from './edge-cases.js';
import { legacyOutlineExtent, nativeOutlineExtent, rgba } from '../settings/native.js';
import { regionHoles, frameFamily, axisFamily } from './region-structure.js';

const LABELS = Object.freeze({ empty: 'Empty', 'outline-only': 'Outline strokes', hash: 'Hash (#)',
  'hollow-square': 'Hollow square', 'hollow-rectangle': 'Hollow rectangle',
  dot: 'Dot', 'horizontal-bar': 'Horizontal bar', 'vertical-bar': 'Vertical bar', rectangle: 'Solid rectangle',
  cross: 'Cross', t: 'T', 'inverted-t': 'Inverted T', 'asymmetric-cross': 'Asymmetric cross',
  'sideways-t': 'Sideways T', corner: 'Corner', 'horizontal-fragments': 'Horizontal fragments',
  'vertical-fragments': 'Vertical fragments', 'irregular-core': 'Irregular core' });

/** Area, bounds and edge-connected components of disjoint compressed cells (corner contact is not connection). */
export function regionFacts(cells) {
  if (!cells.length) return { area: 0, bounds: null, width: 0, height: 0, components: 0, solid: false,
    holes: 0, holeArea: 0 };
  const bounds = { x0: Math.min(...cells.map(r => r.x0)), x1: Math.max(...cells.map(r => r.x1)),
    y0: Math.min(...cells.map(r => r.y0)), y1: Math.max(...cells.map(r => r.y1)) };
  const area = cells.reduce((n, r) => n + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
  const parents = cells.map((_, i) => i), root = i => { while (parents[i] !== i) i = parents[i]; return i; };
  for (let i = 0; i < cells.length; i++) for (let j = 0; j < i; j++) {
    const a = cells[i], b = cells[j];
    const horizontal = (a.x1 === b.x0 || b.x1 === a.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
    const vertical = (a.y1 === b.y0 || b.y1 === a.y0) && Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0);
    if (horizontal || vertical) parents[root(i)] = root(j);
  }
  const width = bounds.x1 - bounds.x0, height = bounds.y1 - bounds.y0;
  const holes = regionHoles(cells);
  return { area, bounds, width, height, components: new Set(parents.map((_, i) => root(i))).size,
    solid: area === width * height, holes: holes.length, holeArea: holes.reduce((n, hole) => n + hole.area, 0) };
}

/** Surviving core beyond the central bar band. Areas also reveal unequal overpaint with equal outer bounds. */
function visibleArms(regions, [low, high]) {
  const area = { left: 0, right: 0, up: 0, down: 0 };
  for (const r of regions) {
    const width = r.x1 - r.x0, height = r.y1 - r.y0;
    area.left += Math.max(0, Math.min(r.x1, low) - r.x0) * height;
    area.right += Math.max(0, r.x1 - Math.max(r.x0, high)) * height;
    area.up += Math.max(0, Math.min(r.y1, low) - r.y0) * width;
    area.down += Math.max(0, r.y1 - Math.max(r.y0, high)) * width;
  }
  return { directions: Object.keys(area).filter(key => area[key] > 0), area };
}

function armFamily(core, arms, [low, high]) {
  const { left, right, up, down } = arms.area;
  if (arms.directions.length === 4) {
    const b = core.bounds;
    return left === right && up === down && low - b.x0 === b.x1 - high && low - b.y0 === b.y1 - high
      ? 'cross' : 'asymmetric-cross';
  }
  if (left && right && (up || down)) return up ? 'inverted-t' : 't';
  if (up && down && (left || right)) return 'sideways-t';
  if ((left || right) && (up || down)) return 'corner';
  if (left || right) return 'horizontal-fragments';
  if (up || down) return 'vertical-fragments';
  return 'irregular-core';
}

/** Recognize the visible core after old per-element outline overpaint, or new fill-over-outline compositing.
 * A dot is any visible solid square, including crossed/occluded arms; the input dot flag is not the classifier.
 * Black fill plus black outline has no separate aiming colour and is treated as a single silhouette. */
export function classifyShape(g, settings, { legacy = true, outlineMode = 'auto' } = {}) {
  const extent = legacy ? legacyOutlineExtent(settings) : nativeOutlineExtent(settings, outlineMode);
  const color = rgba(settings), sameInk = color.rgb.every(v => v === 0) && extent.low + extent.high > 0;
  const colors = { core: sameInk ? 'ink' : 'core', outline: sameInk ? 'ink' : 'outline' };
  const layers = color.alpha === 0 ? [] : (legacy ? legacyAppearance : appearance)(g, settings, extent, colors);
  const regions = visibleRegions(layers), coreRegions = regions.filter(r => r.color === colors.core);
  const core = regionFacts(coreRegions), band = geometryCellEdges(g).across, arms = visibleArms(coreRegions, band);
  const outline = regionFacts(regions.filter(r => r.color === 'outline')), silhouette = regionFacts(regions);
  const rawCore = regionFacts(visibleRegions((legacy ? legacyAppearance : appearance)(
    g, settings, { low: 0, high: 0 }, colors)));
  const stem = tShape(g, settings, extent), fold = foldCrossedArms(g).kind, edges = drawingEdges(g);
  let family = core.area ? armFamily(core, arms, band) : 'empty';
  if (!silhouette.area) family = 'empty';
  else if (!core.area || rawCore.area === 0) family = 'outline-only';
  else if (core.solid) family = core.width === core.height ? 'dot'
    : core.height === 1 ? 'horizontal-bar' : core.width === 1 ? 'vertical-bar' : 'rectangle';
  const material = !silhouette.area ? 'empty' : !core.area || rawCore.area === 0 ? 'outline-only' : sameInk ? 'single-ink'
    : outline.area ? 'core-and-outline' : 'core-only';
  const shapeRegions = material === 'outline-only' ? regions : coreRegions;
  const shapeFacts = material === 'outline-only' ? silhouette : core;
  const structure = frameFamily(shapeRegions, shapeFacts) ?? axisFamily(shapeRegions, shapeFacts);
  if (structure) family = structure;
  const topology = !(g.length > 0) ? 'no-arms' : fold !== 'none' ? `crossed-${fold}`
    : edges.near + edges.far <= 0 ? 'touching' : 'separated';
  return { family, label: LABELS[family], topology, material, core, outline, silhouette, visibleArms: arms,
    silhouetteFamily: frameFamily(regions, silhouette),
    preserveAim: family === 'dot' && !sameInk, ink: sameInk ? 'single-colour' : 'distinct-core',
    hiddenCorePixels: legacy && !sameInk && color.alpha > 0 ? Math.max(0, rawCore.area - core.area) : 0,
    dotRequested: Boolean(settings.dot), tFamily: stem?.family ?? null,
    widthParity: (band[1] - band[0]) % 2 ? 'odd' : 'even',
    outlineKind: extent.low + extent.high === 0 ? 'none' : extent.low !== extent.high ? 'asymmetric'
      : extent.low > 1 ? 'wide' : 'full',
    opacity: color.alpha === 0 ? 'transparent' : !settings.alpha_enabled ? 'additive'
      : color.alpha === 255 ? 'opaque' : 'translucent',
    motion: settings.style === 4 ? settings.recoil ? 'recoil-following' : 'static' : 'dynamic-at-rest',
    recoilFollowing: Boolean(settings.recoil), weaponDependent: Boolean(settings.weapon_gap) };
}
