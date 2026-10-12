/** No libraries, deterministic inference and group-resampling primitives. */
export function logSumExp(xs) { const m = Math.max(...xs); if (!Number.isFinite(m))
    return m; return m + Math.log(xs.reduce((n, x) => n + Math.exp(x - m), 0)); }
export function normalizeLogs(xs) { const z = logSumExp(xs); if (!Number.isFinite(z))
    throw new Error('All models have non-finite likelihood.'); return xs.map(x => Math.exp(x - z)); }
export function entropy(p) { return -p.reduce((v, x) => v + (x > 0 ? x * Math.log2(x) : 0), 0); }
export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
export function quantile(xs, q) { if (!xs.length)
    return null; const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * q, j = Math.floor(i); return s[j] + (s[Math.min(j + 1, s.length - 1)] - s[j]) * (i - j); }
export function rng(seed = 23092026) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function hash(text) { let n = 2166136261; for (const c of text) {
    n ^= c.charCodeAt(0);
    n = Math.imul(n, 16777619);
} return n >>> 0; }
/** Resamples independent-design clusters, never treats seven heights as seven people. */
export function clusterBootstrap(clusterRates, repeats = 2000, seed = 23092026) {
    if (!clusterRates.length)
        return { mean: null, lower: null, upper: null, clusters: 0, repeats };
    const random = rng(seed), out = [];
    for (let k = 0; k < repeats; k++) {
        let v = 0;
        for (let i = 0; i < clusterRates.length; i++)
            v += clusterRates[Math.floor(random() * clusterRates.length)];
        out.push(v / clusterRates.length);
    }
    return { mean: mean(clusterRates), lower: quantile(out, .025), upper: quantile(out, .975), clusters: clusterRates.length, repeats, seed, interpretation: 'Descriptive cluster-resampling stability interval; not game-correctness confidence.' };
}
export function wilson(successes, total, z = 1.959963984540054) {
    if (!Number.isInteger(total) || total < 0 || !Number.isInteger(successes) || successes < 0 || successes > total)
        throw new Error('Invalid success count.');
    if (!total)
        return { rate: null, lower: null, upper: null, total: 0, successes: 0 };
    const p = successes / total, d = 1 + z * z / total, c = (p + z * z / (2 * total)) / d, h = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
    return { rate: p, lower: successes === 0 ? 0 : Math.max(0, c - h), upper: successes === total ? 1 : Math.min(1, c + h), total, successes };
}
export const effectiveN = weights => { const s = weights.reduce((a, b) => a + b, 0), ss = weights.reduce((a, b) => a + b * b, 0); return ss ? s * s / ss : 0; };
