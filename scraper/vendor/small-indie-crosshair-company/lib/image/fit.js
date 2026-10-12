/** Exact rectangle-union scoring against an integral image, including overlapping arms. */
import { rectangles, raster, compareMasks } from '../geometry/raster.js';

function summed(mask) {
  const s = mask.side, n = s + 1, ii = new Int32Array(n * n);
  for (let y = 0; y < s; y++) {
    let sum = 0;
    for (let x = 0; x < s; x++) {
      sum += mask.data[y * s + x];
      ii[(y + 1) * n + x + 1] = ii[y * n + x + 1] + sum;
    }
  }
  return ii;
}

function intersection(a, b) {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}
const area = b => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const rank = (a, b) => b.score - a.score || Number(a.g.near < 0) - Number(b.g.near < 0) ||
  a.g.length - b.g.length || a.g.width - b.g.width || Math.abs(a.g.near) - Math.abs(b.g.near);

/** Inclusion-exclusion visits at most 31 nonempty intersections (five rectangles). */
function unionScore(boxes, ii, side) {
  let pixels = 0, overlap = 0;
  const n = side + 1;
  function visit(start, parent, sign) {
    for (let i = start; i < boxes.length; i++) {
      const box = parent ? intersection(parent, boxes[i]) : boxes[i], count = area(box);
      if (!count) continue;
      pixels += sign * count;
      const [x0, y0, x1, y1] = intersection(box, [0, 0, side, side]);
      if (x1 > x0 && y1 > y0)
        overlap += sign * (ii[y1 * n + x1] - ii[y1 * n + x0] - ii[y0 * n + x1] + ii[y0 * n + x0]);
      visit(i + 1, box, -sign);
    }
  }
  visit(0, null, 1);
  return { pixels, overlap };
}

export function fitMask(mask) {
  const ii = summed(mask), half = (mask.side - 1) / 2, shortlist = [];
  const total = mask.data.reduce((sum, value) => sum + value, 0);
  let tested = 0, bestScore = -1, tiedTemplates = 0;
  for (let width = 1; width <= 16; width++)
    for (let length = 0; length <= 48; length++)
      for (let near = -16; near <= 24; near++)
        for (const dot of [false, true])
          for (const t_style of [false, true]) {
            if (length === 0 && (!dot || near !== 0 || t_style)) continue;
            const g = { length, width, near, far: near + 1 }, flags = { dot, t_style };
            const boxes = rectangles(g, flags).map(r => [Math.ceil(r.x - .5) + half,
              Math.ceil(r.y - .5) + half, Math.ceil(r.x + r.w - .5) + half, Math.ceil(r.y + r.h - .5) + half]);
            const { pixels, overlap } = unionScore(boxes, ii, mask.side);
            const score = overlap / Math.max(1, total + pixels - overlap);
            tested++;
            if (score > bestScore) { bestScore = score; tiedTemplates = 0; }
            if (score === bestScore) tiedTemplates++;
            const candidate = { g, flags, score };
            if (shortlist.length < 5 || rank(candidate, shortlist.at(-1)) < 0) {
              shortlist.push(candidate);
              shortlist.sort(rank);
              if (shortlist.length > 5) shortlist.pop();
            }
          }
  const best = shortlist[0];
  return { ...best, metric: compareMasks(raster(best.g, best.flags, mask.side), mask), tested, tiedTemplates,
    alternatives: shortlist.map(x => ({ geometry: x.g, flags: x.flags, iou: x.score })),
    method: 'exhaustive-exact-union; L 0–48, W 1–16, near -16–24' };
}
