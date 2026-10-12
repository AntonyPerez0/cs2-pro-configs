/** Proofs that an old visible look cannot be drawn by the current renderer model (build 2000922; the crosshair cvars
 * are unchanged in 2000927). Sound, not complete: an empty result means no proof was found, not that a tuple exists.
 * The new renderer draws one fill colour over one outline colour, and its outline is the fill grown by `{low, high}`
 * from `cl_crosshair_drawoutline` 0/1/2 (no width cvar). So the visible fill must be the old cells of one colour, and
 * the other colour must be exactly that fill grown and minus itself. Every modelled fill (arms, dot, T) is mirror-
 * symmetric left to right (tests/lib/drawability.test.mjs sweeps the forward model). Model evidence, not a capture. */
import { visibleRegions, compareAppearance } from './appearance.js';

export const DRAWABILITY_BUILD = Object.freeze({ model: '2000922', cvarsUnchanged: ['2000927'] });
const EXTENTS = [{ low: 1, high: 1 }, { low: 1, high: 0 }];

const grow = ({ low, high }) => r => ({ x0: r.x0 - low, x1: r.x1 + high, y0: r.y0 - low, y1: r.y1 + high });
const same = (a, b) => compareAppearance(a, b).different === 0;
const mirror = cells => {
  const axis = Math.min(...cells.map(r => r.x0)) + Math.max(...cells.map(r => r.x1));
  return cells.map(r => ({ ...r, x0: axis - r.x1, x1: axis - r.x0 }));
};
const symmetric = cells => same([{ color: 1, boxes: cells }], [{ color: 1, boxes: mirror(cells) }]);

/**
 * Why the visible `layers` (any painter's output, e.g. `oldAppearance`) cannot be drawn by the new renderer.
 * Each visible colour is tried as the fill (the other as the outline); a reason is reported only when every
 * assignment fails, and the reasons are those of the preferred one: `core` as the fill when it is visible.
 * @param {Array<{color: string, boxes: Array}>} layers - painted layers, later on top.
 * @param {string} core - colour key of the old fill.
 * @returns {{impossible: boolean, reasons: string[]}} reasons: `outline-reach`, `not-mirror-symmetric`.
 */
export function drawability(layers, core) {
  const regions = visibleRegions(layers);
  const colours = [...new Set(regions.map(r => r.color))].sort((a, b) => (b === core) - (a === core));
  const failures = colours.map(fill => {
    const fills = regions.filter(r => r.color === fill), edge = colours.find(c => c !== fill), reasons = [];
    const reached = edge === undefined || EXTENTS.some(extent =>
      same(layers, [{ color: edge, boxes: fills.map(grow(extent)) }, { color: fill, boxes: fills }]));
    if (!reached) reasons.push('outline-reach');
    if (!symmetric(fills)) reasons.push('not-mirror-symmetric');
    return reasons;
  });
  const impossible = failures.length > 0 && failures.every(reasons => reasons.length);
  return { impossible, reasons: impossible ? failures[0] : [] };
}
