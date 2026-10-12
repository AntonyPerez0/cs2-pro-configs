/** Explicit aiming-identity objective. Total appearance IoU remains a separate diagnostic, never relabelled. */
import { appearanceScorer } from '../geometry/appearance.js';
import { classifyShape } from '../geometry/shape-taxonomy.js';
import { rgba } from '../settings/native.js';
import { oldAppearance } from './community-edge.js';

export { COMMUNITY_REVISION as IMPLEMENTATION_REVISION } from '../geometry/community.js';

/** Dot-like visible cores prioritize their actual visible pixels; all other families retain appearance ranking.
 * Both objectives use one shared translation per comparison, so core and outline cannot align independently. */
export function aimShapeObjective(settings, target, enabled = true) {
  const taxonomy = classifyShape(target, settings), { rgb, alpha } = rgba(settings);
  const preserve = enabled && taxonomy.preserveAim;
  const score = appearanceScorer(oldAppearance(settings, target), { aimColor: preserve ? `${rgb.join(',')},${alpha}` : null });
  return { taxonomy, preserve, score, rule: preserve ? 'visible-core-then-appearance' : 'appearance-overlap' };
}

/** Positive iff a improves on b; epsilon is only for comparing numerical objectives, not pixels. */
export function compareAimScores(a, b) {
  const values = score => score.alignedAim === undefined ? [score.aligned ?? -1]
    : [score.alignedAim ?? -1, score.aimAlignedAppearance ?? -1];
  const x = values(a), y = values(b);
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - y[i]) > 1e-9) return x[i] - y[i];
  return 0;
}
