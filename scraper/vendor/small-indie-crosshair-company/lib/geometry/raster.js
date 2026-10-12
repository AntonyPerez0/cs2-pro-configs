/** Illustrative binary raster, not an extracted CS2 shader. See math/04-rendering.md. */
import { finite, height as validHeight } from '../settings/validation.js';
export const RASTER_CONVENTION = 'illustrative-parity-v2';
export const RAW_EDGE_CONVENTION = 'measured-edges-v1';
export const COMMUNITY_CONVENTION = 'community-static-pixels-v1';

/** Convert model offsets to drawing edges; measured pixel edges are already literal. */
export function drawingEdges(g, convention = g.rasterConvention ?? RASTER_CONVENTION) {
  if (![RASTER_CONVENTION, RAW_EDGE_CONVENTION, COMMUNITY_CONVENTION].includes(convention))
    throw new Error('Unknown raster convention.');
  const correction = convention === RASTER_CONVENTION && Number.isInteger(g.width) && g.width % 2 === 0 ? 1 : 0;
  return { near: g.near, far: g.far - correction };
}

/** The pixel cell a coordinate falls in, by pixel centres (a centre exactly on an edge belongs to the cell above). */
export const cell = value => Math.ceil(value - .5);

/** Transverse edge of the bars: the explicit `axisStart`, else centred on the origin (rounded up in the community
 * convention). The one place that formula lives; `placement` and the edge-case rules both use it. */
export function axisStartOf(g, convention = g.rasterConvention ?? RASTER_CONVENTION) {
  return g.axisStart === undefined ? (convention === COMMUNITY_CONVENTION ? 0 - Math.ceil(g.width/2) : 0 - Math.floor(g.width/2))
    : finite(g.axisStart, 'Transverse edge', -1000000, 1000000);
}

/** Scale dimensions for fitting while retaining original integer endpoints for exact screen-cell sampling.
 * Fractional or independently measured sources keep the ordinary floating-point geometry path. */
export function scaleScreenGeometry(g, oldHeight, currentHeight, integerSource = true) {
  validHeight(oldHeight); validHeight(currentHeight);
  const factor = currentHeight / oldHeight, { screenSource: previous, ...target } = g;
  if (factor === 1) return target;
  const { near, far } = drawingEdges(g), axisStart = axisStartOf(g);
  target.length *= factor; target.width *= factor;
  target.near = near * factor; target.far = far * factor; target.axisStart = axisStart * factor;
  target.rasterConvention = RAW_EDGE_CONVENTION;
  const source = { length: g.length, width: g.width, near, far, axisStart, oldHeight, currentHeight };
  if (integerSource && Object.values(source).every(Number.isSafeInteger)) {
    target.screenSource = source;
    geometryCellEdges(target); // Validate the provenance and safe endpoint products before publishing it.
  }
  return target;
}

/** Exact ceil((2 * edge * currentHeight - oldHeight) / (2 * oldHeight)). Integer remainder avoids a quotient
 * rounded onto an integer boundary. All arithmetic products must stay within JavaScript's safe integer range. */
function screenCell(edge, oldHeight, currentHeight) {
  const product = 2 * edge * currentHeight, numerator = product - oldHeight, denominator = 2 * oldHeight;
  if (![edge, product, numerator, denominator].every(Number.isSafeInteger))
    throw new Error('Screen edge sampling exceeds safe integer arithmetic.');
  const remainder = numerator % denominator;
  return (numerator - remainder) / denominator + Number(remainder > 0);
}

/** Sample each rectangle endpoint independently. Provenance is screen-only and must still describe the geometry;
 * transforms that change dimensions/placement must discard it rather than reuse stale source endpoints. */
export function geometryCellEdges(g) {
  const source = g.screenSource;
  let L = g.length, W = g.width, { near: a, far: b } = drawingEdges(g), t = axisStartOf(g), sample = cell;
  if (source !== undefined) {
    if (!source || typeof source !== 'object' || Array.isArray(source) ||
        !['length', 'width', 'near', 'far', 'axisStart', 'oldHeight', 'currentHeight']
          .every(key => Number.isSafeInteger(source[key])) || source.length < 0 || source.width < 0)
      throw new Error('Invalid integer screen-source provenance.');
    validHeight(source.oldHeight); validHeight(source.currentHeight);
    const factor = source.currentHeight / source.oldHeight;
    if (g.rasterConvention !== RAW_EDGE_CONVENTION || factor === 1 ||
        L !== source.length * factor || W !== source.width * factor || a !== source.near * factor ||
        b !== source.far * factor || t !== source.axisStart * factor)
      throw new Error('Screen-source provenance does not describe this geometry.');
    ({ length: L, width: W, near: a, far: b, axisStart: t } = source);
    sample = edge => screenCell(edge, source.oldHeight, source.currentHeight);
  }
  return { left: [sample(-a - L), sample(-a)], right: [sample(b), sample(b + L)], across: [sample(t), sample(t + W)] };
}

/** Shared arm placement: the bar rects (zero-length ones included) and the dot rect, or null when width <= 0. */
function placement(g, {dot=false,t_style=false}, convention) {
  const {length:L,width:W}=g;
  const {near:a,far:b}=drawingEdges(g, convention);
  const t = axisStartOf(g, convention);
  if (W <= 0) return null;
  if (g.screenSource !== undefined) {
    const { left: [l0, l1], right: [r0, r1], across: [t0, t1] } = geometryCellEdges(g), width = t1 - t0;
    const bars = [{ x: l0, y: t0, w: l1 - l0, h: width }, { x: r0, y: t0, w: r1 - r0, h: width },
      { x: t0, y: r0, w: width, h: r1 - r0 }];
    if (!t_style) bars.push({ x: t0, y: l0, w: width, h: l1 - l0 });
    // Keep zero-area cell rectangles: integer outline growth can still make them visible.
    return { bars, dot: dot ? { x: t0, y: t0, w: width, h: width } : null };
  }
  const bars = [{x:-a-L,y:t,w:L,h:W},{x:b,y:t,w:L,h:W},{x:t,y:b,w:W,h:L}];
  if(!t_style)bars.push({x:t,y:-a-L,w:W,h:L});
  return {bars, dot: dot ? {x:t,y:t,w:W,h:W} : null};
}

export function rectangles(g, flags={}, convention = g.rasterConvention ?? RASTER_CONVENTION) {
  const placed = placement(g, flags, convention);
  if (!placed) return [];
  return [...(g.length>0 ? placed.bars : []), ...(placed.dot ? [placed.dot] : [])];
}
/** Zero-length bars keep their outline in the old game; the new game draws nothing for them (user capture,
 * issue #11, 2026-10-02), so the community convention drops them by default. */
const outlinesZeroLength = convention => convention !== COMMUNITY_CONVENTION;
/** Outline rectangles, one per bar and dot, in the centred coordinates of `rectangles`. `outline` is
 * `{ low, high }`: pixels added left/top and right/bottom. `zeroLength` keeps zero-length bar outlines. */
export function outlineRectangles(g, flags={}, outline, convention = g.rasterConvention ?? RASTER_CONVENTION,
  zeroLength = outlinesZeroLength(convention)) {
  const {low,high}=outline;
  const placed = placement(g, flags, convention);
  if (!placed || low + high <= 0) return [];
  const grow = r => ({x:r.x-low,y:r.y-low,w:r.w+low+high,h:r.h+low+high});
  return [...(g.length > 0 || zeroLength ? placed.bars : []), ...(placed.dot ? [placed.dot] : [])].map(grow);
}
/** Old draw order (cstrike15 DrawCrosshairRect calls): left, right, top, bottom, then the dot. Each element
 * paints its outline and then its fill, so a later outline covers earlier fills where they overlap.
 * Returns `[{ outline, fill }]` in that order, either rect null when the element draws none. */
export function legacyElements(g, flags={}, outline={low:0,high:0}, convention = g.rasterConvention ?? RASTER_CONVENTION,
  zeroLength = true) {
  const {low,high}=outline;
  const placed = placement(g, flags, convention);
  if (!placed) return [];
  const [left, right, bottom, top] = placed.bars, grow = r => ({x:r.x-low,y:r.y-low,w:r.w+low+high,h:r.h+low+high});
  const bar = r => ({ outline: low + high > 0 && (g.length > 0 || zeroLength) ? grow(r) : null, fill: g.length > 0 ? r : null });
  return [...[left, right, top, bottom].filter(Boolean).map(bar),
    ...(placed.dot ? [{ outline: low + high > 0 ? grow(placed.dot) : null, fill: placed.dot }] : [])];
}
/** True when the old coloured core is empty but its outline still draws (size 0 with an outline, legacy rule). */
export function outlineOnly(g, {dot=false}={}, outline) {
  return g.width > 0 && !(g.length > 0) && !dot && outline.low + outline.high > 0;
}
function paintCells(data, side, r, value) {
  // Coverage at pixel centers, deterministic even for fractional research hypotheses.
  const half=Math.floor(side/2);
  const left=Math.max(0,cell(r.x)+half),top=Math.max(0,cell(r.y)+half);
  const right=Math.min(side,cell(r.x+r.w)+half),bottom=Math.min(side,cell(r.y+r.h)+half);
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++)data[y*side+x]=value;
}
const croppedBy = (boxes, side) => { const half=Math.floor(side/2);
  return boxes.some(r=>r.x < -half || r.y < -half || r.x+r.w>half+1||r.y+r.h>half+1); };
function fill(boxes, side) {
  if(!Number.isInteger(side)||side<9||side>513||side%2!==1)throw new Error('Raster side must be odd, 9–513.');
  const data=new Uint8Array(side*side);
  for(const r of boxes) paintCells(data, side, r, 1);
  return {data,side,cropped:croppedBy(boxes, side)};
}
export function raster(g, flags={}, side=161, convention = g.rasterConvention ?? RASTER_CONVENTION) {
  const {data,cropped}=fill(rectangles(g,flags,convention), side);
  return {data,side,convention,cropped};
}
/** Outline-only mask for previews; never part of `compareMasks` or the solver objective. */
export function outlineRaster(g, flags, outline, side=161, convention = g.rasterConvention ?? RASTER_CONVENTION,
  zeroLength = outlinesZeroLength(convention)) {
  const {data,cropped}=fill(outlineRectangles(g,flags,outline,convention,zeroLength), side);
  return {data,side,convention,cropped};
}
/** Old preview masks painted in the old draw order (`legacyElements`): `core` and `outline` hold the pixels each
 * layer shows on top, so outline pixels painted over an earlier fill count as outline. */
export function legacyRaster(g, flags, outline, side=161, convention = g.rasterConvention ?? RASTER_CONVENTION) {
  const elements = legacyElements(g, flags, outline, convention), boxes = elements.flatMap(e => [e.outline, e.fill].filter(Boolean));
  const {data:labels} = fill([], side);
  for (const e of elements) for (const [r, value] of [[e.outline, 1], [e.fill, 2]]) if (r) paintCells(labels, side, r, value);
  const mask = value => ({ data: labels.map(v => Number(v === value)), side, convention, cropped: croppedBy(boxes, side) });
  return { core: mask(2), outline: mask(1) };
}
export function compareMasks(a,b) {
  if(a.side!==b.side)throw new Error('Raster sizes must match.');
  let union=0,different=0,intersection=0;
  a.data.forEach((v,i)=>{union+=Number(!!(v||b.data[i]));intersection+=Number(!!(v&&b.data[i]));different+=Number(v!==b.data[i]);});
  return {different,intersection,union,iou:union?intersection/union:null,cropped:a.cropped||b.cropped,
    scope:'Synthetic binary geometry masks only; no color, alpha, outline or game validation.'};
}
