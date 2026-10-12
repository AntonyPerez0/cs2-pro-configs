import { decodeLegacy } from '../settings/sharecode.js';
import { legacyGeometry, comparators } from './legacy.js';
export const HEIGHTS = [720,768,960,1024,1080,1440,2160];
export function runAudit(presets) {
  const counts = Object.fromEntries(['round_scaled','fixed_2x','hauptrolle_preview'].map(k=>[k,
    {length_disagreements:0,thickness_disagreements:0,any_dimension_disagreements:0}]));
  const rows=[];
  for (const p of presets) {
    const settings = decodeLegacy(p.code);
    for (const height of HEIGHTS) {
      const old=legacyGeometry(settings,height), alternatives=comparators(settings,height);
      for (const [name,pair] of Object.entries(alternatives)) {
        const a=pair[0]!==old.length,b=pair[1]!==old.width;
        counts[name].length_disagreements+=Number(a); counts[name].thickness_disagreements+=Number(b);
        counts[name].any_dimension_disagreements+=Number(a||b);
      }
      rows.push({player:p.player,date:p.observed_date,height,size:settings.size,thickness:settings.thickness,
        gap:settings.gap,old,alternatives});
    }
  }
  return {scope:'Source-model comparisons only; zero in-game observations.',cases:rows.length,counts,rows};
}
