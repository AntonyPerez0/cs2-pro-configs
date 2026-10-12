import { componentBounds, axisComponents, barGeometry } from './components.js';
import { fitMask } from './fit.js';
/** Bounded color segmentation and template fitting. No OCR and no game-process access. */
import { raster, compareMasks, RASTER_CONVENTION, RAW_EDGE_CONVENTION } from '../geometry/raster.js';
import { finite, height as validateHeight } from '../settings/validation.js';
import { validateMask, compileMask } from '../geometry/pixel-shape.js';
import { regionFacts } from '../geometry/shape-taxonomy.js';
import { frameFamily } from '../geometry/region-structure.js';
export function pngDimensions(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 24 || [137, 80, 78, 71, 13, 10, 26, 10].some((v, i) => bytes[i] !== v))
        throw new Error('Use an original PNG screenshot.');
    if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR')
        throw new Error('Invalid PNG header.');
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), width = d.getUint32(16), height = d.getUint32(20);
    if (!width || !height || width > 8192 || height > 8192 || width * height > 20000000)
        throw new Error('PNG exceeds the 20-million-pixel / 8192-side safety limit.');
    return { width, height };
}
function colorCandidates(data, side, dark = false) {
    const counts = new Map(), center = (side - 1) / 2;
    // Every supported width (1..16) lies inside these axis strips. Large gaps can put all bars beyond 18 px.
    for (let y = 0; y < side; y++)
        for (let x = 0; x < side; x++) {
            if ((x < center - 8 || x >= center + 8) && (y < center - 8 || y >= center + 8)) continue;
            const i = (y * side + x) * 4, rgb = [data[i], data[i + 1], data[i + 2]], max = Math.max(...rgb), min = Math.min(...rgb);
            const bright = max >= 70 && (max - min >= 65 || min >= 180);
            if ((dark ? bright || max - min >= 65 : !bright) || data[i + 3] < 180)
                continue;
            const key = rgb.map(v => Math.round(v / 8) * 8).join('/'), item = counts.get(key) ?? { count: 0, axial: 0, rgb };
            item.count++;
            // An actual core crosses a centre axis; off-axis scene patches must not consume the five fitting slots.
            item.axial += Number(Math.abs(x - center) <= 1 || Math.abs(y - center) <= 1);
            counts.set(key, item);
        }
    return [...counts.values()].sort((a, b) => b.axial - a.axial || b.count - a.count).slice(0, 5).map(x => x.rgb);
}
export const automaticColor = (data, side) => colorCandidates(data, side);

/** Only exact hollow stroke structures qualify for automatic neutral/dark fallback. Ordinary dark scenery,
 * solid patches and isolated dots do not. The normal fit, clipping and stability gates still apply. */
function detectedFrame(mask) {
    const cells = compileMask(mask).bands.flatMap(b => b.spans.map(([y0, y1]) => ({ x0: b.x0, x1: b.x1, y0, y1 })));
    // A two-by-two full-span stroke union has at most eight runs in this canonical mask decomposition.
    // Reject scene noise before the pairwise connectivity work used for small geometry-region sets.
    if (cells.length > 8) return null;
    return frameFamily(cells, regionFacts(cells));
}

/** Transparent padding hides original-image clipping from crop-edge checks. Inspect only selected foreground
 * on source pixels: a small, complete source image remains usable when its foreground stays off its edges. */
export function sourceBoundaryClipped(mask, { width, height }, center) {
    validateMask(mask);
    if (![width, height, ...center].every(Number.isInteger) || width < 1 || height < 1 || center.length !== 2 ||
        center[0] < 0 || center[1] < 0 || center[0] >= width || center[1] >= height)
        throw new Error('Source dimensions and center must be valid integer image coordinates.');
    const half = (mask.side - 1) / 2;
    return mask.data.some((value, i) => {
        if (!value) return false;
        const x = i % mask.side + center[0] - half, y = Math.floor(i / mask.side) + center[1] - half;
        return x >= 0 && x < width && y >= 0 && y < height && (x === 0 || x === width - 1 || y === 0 || y === height - 1);
    });
}
export function segment(data, side, rgb, tolerance = 40) {
    if (!Array.isArray(rgb) || rgb.length !== 3)
        throw new Error('Select a crosshair-colored pixel.');
    rgb.forEach(v => finite(v, 'Color', 0, 255));
    finite(tolerance, 'Segmentation tolerance', 1, 120);
    const mask = new Uint8Array(side * side);
    let total = 0;
    for (let i = 0; i < mask.length; i++) {
        const j = i * 4;
        mask[i] = Number(data[j + 3] > 32 && Math.hypot(data[j] - rgb[0], data[j + 1] - rgb[1], data[j + 2] - rgb[2]) <= tolerance);
        total += mask[i];
    }
    if (total < 1 || total > side * side * .35)
        throw new Error('Segmentation is empty or mostly background. Click a colored crosshair pixel or adjust the center/tolerance.');
    const cropped = mask.some((value, i) => value &&
        (i < side || i >= side * (side - 1) || i % side === 0 || i % side === side - 1));
    return { data: mask, side, cropped, total };
}

/** Nearby RGB thresholds test segmentation stability, not statistical correctness. */
export function segmentationQuality(data, side, color, tolerance, mask) {
    const thresholds = [...new Set([Math.max(1, tolerance - 8), tolerance, Math.min(120, tolerance + 8)])];
    const agreements = thresholds.map(value => {
        try { return compareMasks(mask, segment(data, side, color, value)).iou ?? 0; }
        catch { return 0; }
    });
    const minimumIou = Math.min(...agreements);
    return { thresholds, agreements, minimumIou, stable: minimumIou >= .98,
        scope: 'Mask agreement under nearby color thresholds; not a correctness probability.' };
}

export function communityBuckets(g, height) {
    validateHeight(height);
    const scale = Math.fround(height / 480);
    const interval = (pixels, minimum = false) => ({ lower: minimum ? 0 : Math.max(0, (pixels - .5) / scale),
        upper: (pixels + .5) / scale, lowerClosed: minimum || pixels % 2 === 0, upperClosed: pixels % 2 === 0 });
    return { size: interval(g.length), thickness: interval(g.width, g.width === 1), gap: legacyBuckets(g, height).gap,
        model: 'legacy-community-f32-even-v1',
        caveat: 'Ideal half-even intervals; binary32 arithmetic can move endpoints. Measured pixels do not identify unique cvars.' };
}
export function legacyBuckets(g, height) {
    validateHeight(height);
    const scale = height / 480, p = g.near - Math.floor(g.width / 2);
    return { size: { lower: g.length / scale, upper: (g.length + 1) / scale, lowerClosed: true, upperClosed: false },
        thickness: { lower: g.width === 1 ? 0 : g.width / scale, upper: (g.width + 1) / scale, lowerClosed: true, upperClosed: false, zeroAlsoPossible: g.width === 1 },
        gap: p === 0 ? { lower: -5, upper: -3, lowerClosed: false, upperClosed: false } : p > 0 ? { lower: p - 4, upper: p - 3, lowerClosed: true, upperClosed: false } : { lower: p - 5, upper: p - 4, lowerClosed: false, upperClosed: true },
        caveat: 'Ideal arithmetic buckets; float32 boundary effects and screenshot scaling can change endpoint behavior. These are not unique recovered cvars.' };
}
export function analyzeScreenshot({ data, side = 129, seed = null, tolerance = 40, height = 1080 }) {
    if (!(data instanceof Uint8ClampedArray) && !(data instanceof Uint8Array))
        throw new Error('RGBA bytes required.');
    if (!Number.isInteger(side) || side < 49 || side > 161 || side % 2 !== 1 || data.length !== side * side * 4)
        throw new Error('Use an odd 49–161 px center crop.');
    const colors = seed ? [seed] : automaticColor(data, side);
    let best = null;
    for (const rgb of colors) {
        try {
            const mask = segment(data, side, rgb, tolerance), fit = fitMask(mask);
            if (!best || (fit.metric.iou ?? 0) > (best.fit.metric.iou ?? 0))
                best = { rgb, mask, fit };
        }
        catch (error) {
            if (seed)
                throw error;
        }
    }
    // Keep an acceptable bright/saturated core ahead of its dark outline. A neutral hollow reticle is tried
    // only when that route failed, and only when its measured mask itself is a hash or rectangular frame.
    if (!seed && (!best || best.fit.metric.cropped || best.fit.metric.iou < .9)) {
        for (const rgb of colorCandidates(data, side, true)) {
            try {
                const mask = segment(data, side, rgb, tolerance);
                if (mask.cropped) continue;
                const family = detectedFrame(mask);
                if (!family) continue;
                const fit = fitMask(mask);
                if (!best || fit.metric.iou > best.fit.metric.iou) best = { rgb, mask, fit, detectedFrame: family };
            } catch { /* Background/empty candidates are skipped; a manual colour selection stays available. */ }
        }
    }
    if (!best)
        throw new Error('Could not isolate a bounded static crosshair. Click a crosshair pixel to select its color/center.');
    const g = best.fit.g, buckets = communityBuckets(g, height), scale = Math.fround(height / 480);
    const stability = segmentationQuality(data, side, best.rgb, tolerance, best.mask);
    const acceptable = !best.fit.metric.cropped && stability.stable && best.fit.metric.iou >= .9;
    return { schema: 'sicc-image-inference-v1', rasterConvention: RASTER_CONVENTION, geometry: g, flags: best.fit.flags, color: best.rgb, mask: best.mask, templateIou: best.fit.metric.iou,
        alternatives: best.fit.alternatives, buckets, detectedFrame: best.detectedFrame ?? detectedFrame(best.mask),
        representative: { size: g.length / scale, thickness: g.width / scale, gap: g.near - Math.floor(g.width / 2) - 4 },
        quality: { acceptable, stability, cropped: best.fit.metric.cropped, tiedTemplates: best.fit.tiedTemplates },
        measurementMethod: best.fit.method,
        evaluatedTemplates: best.fit.tested, confidenceType: 'Segmentation/template agreement, NOT a calibrated correctness probability.',
        warnings: ['An image cannot uniquely recover old cvars, original alpha, color preset or resolution.',
            'Original native-resolution captures are required; scaled/video images and anti-aliasing may bias the fit.',
            'Search covers L 0–48, W 1–16, near -16–24. Tied templates remain ambiguous; outlines and dynamics need review.',
            ...(!acceptable ? ['Crop, segmentation stability or fit quality is insufficient. Adjust the crop/color before accepting.'] : [])] };
}
/** Native capture measurement does NOT fit the legacy template or force far = near + 1.
 * It measures disconnected axis-aligned colored components. Merged/ambiguous cores are refused.
 */
export function measureNativeMask(mask, expectedFlags = null) {
  const components = componentBounds(mask);
  if (mask.cropped || components.some(c => c.touchesEdge))
    throw new Error('Foreground reaches the crop boundary. Use a complete uncropped crosshair.');
  let lastError;
  // Both possible centre pixels are classified from component bounds, independently of a renderer model.
  for (const center of [0, -.5]) {
    try {
      const axes = axisComponents(components, center);
      const onlyDot = axes.dot && !axes.left && !axes.right && !axes.top && !axes.bottom;
      const geometry = onlyDot ? { length: 0, width: axes.dot.w, near: 0, far: 0 } : barGeometry(axes);
      const starts = onlyDot ? [axes.dot.minX, axes.dot.minY]
        : [axes.left.minY, axes.right.minY, axes.bottom.minX, ...(axes.top ? [axes.top.minX] : [])];
      if (new Set(starts).size !== 1) throw new Error('Native bars have inconsistent transverse placement.');
      geometry.axisStart = starts[0];
      const flags = { dot: !!axes.dot, t_style: !onlyDot && !axes.top };
      if (axes.dot && axes.dot.w !== geometry.width) throw new Error('Dot and bar widths disagree.');
      if (axes.dot && (axes.dot.minX !== geometry.axisStart || axes.dot.minY !== geometry.axisStart))
        throw new Error('Dot and bars have inconsistent transverse placement.');
      if (components.some(c => c !== axes.dot && c.minX <= 0 && c.maxX >= -1 && c.minY <= 0 && c.maxY >= -1))
        throw new Error('An unexplained central component makes the dot measurement ambiguous.');
      if (expectedFlags && (flags.dot !== expectedFlags.dot || (!onlyDot && flags.t_style !== expectedFlags.t_style)))
        throw new Error('Measured dot/T flags disagree with the declared crosshair. An arm or dot may be missing.');
      if (expectedFlags?.bars !== undefined && expectedFlags.bars !== (geometry.length > 0))
        throw new Error('Measured bar presence disagrees with the declared crosshair. Bars may be missing.');
      const metric = compareMasks(raster(geometry, flags, mask.side, RAW_EDGE_CONVENTION), mask);
      if (metric.cropped || (metric.iou ?? 0) < .9)
        throw new Error('Native component reconstruction does not explain at least 90% of the mask. No native evidence was recorded.');
      return { geometry, flags, templateIou: metric.iou, components, measurementMethod: onlyDot
        ? 'direct-components; pure-dot gap unidentifiable' : 'direct-component bounds; independently measured edges and transverse origin' };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
export function analyzeNativeScreenshot({ data, side = 129, seed = null, tolerance = 40, expectedFlags = null }) {
    if (!(data instanceof Uint8ClampedArray) && !(data instanceof Uint8Array))
        throw new Error('RGBA bytes required.');
    if (!Number.isInteger(side) || side < 49 || side > 161 || side % 2 !== 1 || data.length !== side * side * 4)
        throw new Error('Use an odd 49–161 px center crop.');
    const colors = seed ? [seed] : automaticColor(data, side);
    let best = null, lastError = null;
    for (const color of colors) {
        try {
            const mask = segment(data, side, color, tolerance), fit = measureNativeMask(mask, expectedFlags);
            if (!best || fit.templateIou > best.templateIou)
                best = { ...fit, mask, color };
        }
        catch (e) {
            lastError = e;
        }
    }
    if (!best)
        throw lastError ?? new Error('Select a crosshair-colored pixel for native component measurement.');
    const stability = segmentationQuality(data, side, best.color, tolerance, best.mask);
    return { schema: 'sicc-native-image-measurement-v1', ...best,
        quality: { acceptable: stability.stable, stability, cropped: false },
        confidenceType: 'Component-mask agreement, not correctness confidence.',
        warnings: ['Original native resolution and correct cvars must be attested.',
            'No constraint far = near + 1 was imposed on these measured edges.',
            'Merged bars, outlines, scaling and irregular shapes are not automatically measured.',
            ...(!stability.stable ? ['Color segmentation is unstable. Adjust the crop/color before recording evidence.'] : [])] };
}
