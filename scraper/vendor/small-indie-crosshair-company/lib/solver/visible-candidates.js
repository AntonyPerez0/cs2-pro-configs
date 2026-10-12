/** Extra finite proposals derived from visible strokes, independent of the original cvar dimensions. */
import { visibleRegions } from '../geometry/appearance.js';
import { regionRuns } from '../geometry/region-structure.js';
import { communityDimension } from '../geometry/community.js';
import { NATIVE_RANGES_2000922 as RANGES } from '../settings/native.js';
import { communityAxis } from './community-axis.js';

/** Fit both orientations of each visible run, plus a solid centre proposal. Each axis tries the closest
 * drawable sizes to the measured size and its ±1 px neighbours. Equal raster plateaus retain the original
 * preference order. Flags and outline mode stay fixed; candidates still have to improve the full objective. */
export function visibleCandidates(layers, ratio, initial, preference) {
  const regions = visibleRegions(layers), colors = [...new Set(regions.map(r => r.color))];
  const groups = [regions, ...colors.map(color => regions.filter(r => r.color === color))];
  const wanted = [], seen = new Set(), candidates = new Map();
  for (const cells of groups) for (const r of [...regionRuns(cells), ...regionRuns(cells, true)]) {
    for (const [length, width, low, high] of [[r.x1 - r.x0, r.y1 - r.y0, r.x0, r.x1],
      [r.y1 - r.y0, r.x1 - r.x0, r.y0, r.y1]]) {
      const key = `${length},${width},${low},${high}`;
      if (!seen.has(key)) { seen.add(key); wanted.push({ length, width, low, high }); }
    }
  }
  const axes = new Map();
  const values = (wanted, key, minimum, ideal = preference[key]) => {
    const id = `${wanted},${key},${minimum},${ideal}`;
    if (!axes.has(id)) {
      const drawn = new Map();
      for (const offset of [-1, 0, 1]) {
        const axis = communityAxis(Math.max(minimum, wanted + offset), ratio, RANGES[key].max, minimum);
        for (const v of axis.equivalents) {
          const pixels = communityDimension(v, ratio), prior = drawn.get(pixels);
          if (prior === undefined || Math.abs(v - ideal) < Math.abs(prior - ideal)) drawn.set(pixels, v);
        }
      }
      axes.set(id, [...drawn.values()]);
    }
    return axes.get(id);
  };
  for (const stroke of wanted) for (const thickness of values(stroke.width, 'thickness', 1)) {
    const parity = communityDimension(thickness, ratio) % 2;
    const gaps = [stroke.low + parity, -stroke.high];
    // A square/rectangle spanning the centre can be drawn by arms meeting inside it.
    const centre = stroke.low <= 0 && stroke.high >= 0;
    const lengths = [stroke.length, ...(centre ? [Math.ceil(stroke.length / 2)] : [])];
    for (const wantedGap of [...gaps, ...(centre ? [0] : [])]) {
      if (wantedGap < 0) continue;
      for (const gap of values(wantedGap, 'gap', 0, preference.gap(thickness))) for (const wantedLength of lengths)
        for (const length of values(wantedLength, 'length', initial.length > 0 ? 1 : 0)) {
          const native = { ...initial, length, thickness, gap };
          candidates.set(`${length},${thickness},${gap}`, native);
        }
    }
  }
  return [...candidates.values()];
}
