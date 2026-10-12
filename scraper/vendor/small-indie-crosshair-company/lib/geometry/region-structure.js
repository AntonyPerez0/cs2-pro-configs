/** Topology and strokes of disjoint visible cells. Work scales with rectangle edges, not pixel area. */

/** Merge neighbouring cells into row runs, then join identical runs on consecutive rows. */
export function regionRuns(cells, transpose = false) {
  const boxes = transpose ? cells.map(r => ({ x0: r.y0, x1: r.y1, y0: r.x0, y1: r.x1 })) : cells;
  const ys = [...new Set(boxes.flatMap(r => [r.y0, r.y1]))].sort((a, b) => a - b), result = [];
  let previous = new Map();
  for (let j = 1; j < ys.length; j++) {
    const y0 = ys[j - 1], y1 = ys[j], spans = [];
    for (const r of boxes.filter(r => r.y0 <= y0 && r.y1 >= y1).sort((a, b) => a.x0 - b.x0)) {
      const last = spans.at(-1);
      if (last && r.x0 <= last.x1) last.x1 = Math.max(last.x1, r.x1);
      else spans.push({ x0: r.x0, x1: r.x1 });
    }
    const next = new Map();
    for (const span of spans) {
      const key = `${span.x0},${span.x1}`, prior = previous.get(key);
      const run = prior ?? { ...span, y0, y1 };
      if (prior) prior.y1 = y1;
      else result.push(run);
      next.set(key, run);
    }
    previous = next;
  }
  return transpose ? result.map(r => ({ x0: r.y0, x1: r.y1, y0: r.x0, y1: r.x1 })) : result;
}

/** Edge-connected enclosed background components. Corner contact does not open a hole. */
export function regionHoles(cells) {
  if (!cells.length) return [];
  const axis = (lo, hi) => [...new Set(cells.flatMap(r => [r[lo], r[hi]]))].sort((a, b) => a - b);
  const xs = axis('x0', 'x1'), ys = axis('y0', 'y1');
  xs.unshift(xs[0] - 1); xs.push(xs.at(-1) + 1);
  ys.unshift(ys[0] - 1); ys.push(ys.at(-1) + 1);
  const w = xs.length - 1, h = ys.length - 1, grid = new Uint8Array(w * h);
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  for (const r of cells) for (let y = yi.get(r.y0); y < yi.get(r.y1); y++)
    grid.fill(1, y * w + xi.get(r.x0), y * w + xi.get(r.x1));
  const holes = [];
  for (let start = 0; start < grid.length; start++) {
    if (grid[start]) continue;
    const queue = [start], bounds = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    let area = 0, outside = false;
    grid[start] = 2;
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i], x = p % w, y = Math.floor(p / w);
      outside ||= x === 0 || y === 0 || x === w - 1 || y === h - 1;
      area += (xs[x + 1] - xs[x]) * (ys[y + 1] - ys[y]);
      bounds.x0 = Math.min(bounds.x0, xs[x]); bounds.x1 = Math.max(bounds.x1, xs[x + 1]);
      bounds.y0 = Math.min(bounds.y0, ys[y]); bounds.y1 = Math.max(bounds.y1, ys[y + 1]);
      const neighbours = [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1,
        y > 0 ? p - w : -1, y + 1 < h ? p + w : -1];
      for (const n of neighbours) if (n >= 0 && !grid[n]) { grid[n] = 2; queue.push(n); }
    }
    if (!outside) holes.push({ area, bounds,
      rectangular: area === (bounds.x1 - bounds.x0) * (bounds.y1 - bounds.y0) });
  }
  return holes;
}

/** Exact two-horizontal/two-vertical stroke union, distinguishing a # from a closed rectangular frame. */
export function frameFamily(cells, facts) {
  if (facts.holes !== 1 || facts.components !== 1) return null;
  const b = facts.bounds;
  const horizontal = regionRuns(cells).filter(r => r.x0 === b.x0 && r.x1 === b.x1);
  const vertical = regionRuns(cells, true).filter(r => r.y0 === b.y0 && r.y1 === b.y1);
  if (horizontal.length !== 2 || vertical.length !== 2) return null;
  const ht = horizontal.reduce((n, r) => n + r.y1 - r.y0, 0);
  const vt = vertical.reduce((n, r) => n + r.x1 - r.x0, 0);
  if (ht * facts.width + vt * facts.height - ht * vt !== facts.area) return null;
  const closed = horizontal[0].y0 === b.y0 && horizontal[1].y1 === b.y1 &&
    vertical[0].x0 === b.x0 && vertical[1].x1 === b.x1;
  return closed ? facts.width === facts.height ? 'hollow-square' : 'hollow-rectangle' : 'hash';
}

/** A connected cross/T made from one full-span bar on each axis. Infer its actual bands rather than
 * the requested thickness: very short, very wide native arms can exchange the apparent bar orientations. */
export function axisFamily(cells, facts) {
  if (facts.solid || facts.components !== 1 || facts.holes) return null;
  const b = facts.bounds;
  const rows = regionRuns(cells).filter(r => r.x0 === b.x0 && r.x1 === b.x1);
  const columns = regionRuns(cells, true).filter(r => r.y0 === b.y0 && r.y1 === b.y1);
  if (rows.length !== 1 || columns.length !== 1) return null;
  const row = rows[0], column = columns[0], h = row.y1 - row.y0, w = column.x1 - column.x0;
  if (h * facts.width + w * facts.height - w * h !== facts.area) return null;
  const left = column.x0 - b.x0, right = b.x1 - column.x1;
  const up = row.y0 - b.y0, down = b.y1 - row.y1;
  if (left && right && up && down) return left === right && up === down ? 'cross' : 'asymmetric-cross';
  if (left && right && (up || down)) return up ? 'inverted-t' : 't';
  if (up && down && (left || right)) return 'sideways-t';
  if ((left || right) && (up || down)) return 'corner';
  return null;
}
