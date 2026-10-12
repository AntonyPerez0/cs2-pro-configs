import { hash, effectiveN } from './statistics.js';
/** Color, alpha, outline are NOT used to multiply colored-arm geometry evidence. */
export function signature(s) { return [s.size, s.thickness, s.gap, Number(s.dot), Number(s.t_style), s.style, Number(s.weapon_gap)].join('|'); }
export function groupedCorpus(records) {
    const groups = new Map();
    for (const x of records) {
        const key = signature(x);
        if (!groups.has(key))
            groups.set(key, { signature: key, records: [], representative: x, fold: hash(key) % 5 });
        groups.get(key).records.push(x);
    }
    return [...groups.values()];
}
/** Legacy-domain similarity is coverage, not evidence of the new renderer. */
export function localSupport(settings, records) {
    const groups = groupedCorpus(records).filter(g => g.representative.style === 4 && !g.representative.weapon_gap);
    const weighted = groups.map(g => { const x = g.representative, d = ((x.size - settings.size) / 2) ** 2 + ((x.thickness - settings.thickness) / 1) ** 2 + ((x.gap - settings.gap) / 3) ** 2 + Number(x.dot !== settings.dot) * 2 + Number(x.t_style !== settings.t_style) * 2; return { signature: g.signature, distance: Math.sqrt(d), weight: Math.exp(-.5 * d), records: g.records.length }; }).sort((a, b) => a.distance - b.distance);
    return { matchingRecords: records.filter(x => signature(x) === signature(settings)).length, exactGeometryGroups: weighted.filter(x => x.distance === 0).length, nearbyGeometryGroups: weighted.filter(x => x.distance <= 1).length, effectiveGeometryGroups: effectiveN(weighted.map(x => x.weight)), nearest: weighted.slice(0, 5), outOfDomain: !weighted.length || weighted[0].distance > 1, interpretation: 'Convenience-corpus coverage of old geometry only; NOT a conversion success probability.' };
}
