/** Competing forward renderers, not recovered Valve code. See docs/math/05-model-families.md. */
import { legacyGeometry } from '../geometry/legacy.js';
import { validateNative, outlineChoice, styleTargetChoice, tShapeChoice, styleBlocker } from '../settings/native.js';
import { height as validateHeight, finite, bool } from '../settings/validation.js';
import { quantize } from '../geometry/quantize.js';
import { COMMUNITY_MODEL, communityForward } from '../geometry/community.js';

/** @typedef {number} GameHeight */ // integer in-game resolution height, pixels, 240-16384
/** @typedef {number} LegacyUnit */ // raw cl_crosshairsize/thickness/gap value, unitless, may be fractional
/** @typedef {number} IntSetting */ // integer native cvar value (length/thickness/gap)
/** @typedef {number} IntPx */ // integer game pixel
/** @typedef {number} Px */ // possibly fractional game pixel (e.g. an 'opening' gap edge before quantization)
/** @typedef {{id: string, scale: ('authored'|'reference1080'|'reference720'), rounding: ('trunc'|'nearest'|'ceil'), gap: ('thickness'|'center'|'opening')}} RendererModel */
/** @typedef {{length: IntSetting, thickness: IntSetting, gap: IntSetting, authoredHeight: GameHeight}} NativeSettings */
/** @typedef {{length: IntPx, width: IntPx, near: Px, far: Px, interval: (Px|null), scale: number, model: string, minimumBranch: boolean}} Geometry */

/** @type {string} Renderer family id for this forward-model hypothesis set. */
export const VERSION = 'quant-static-v6';
/** @type {string} CS2 build this hypothesis set targets. */
export const BUILD = '2000914';
/** @type {Array<('authored'|'reference1080'|'reference720')>} Candidate height-scale references. */
export const SCALES = ['authored', 'reference1080', 'reference720'];
/** @type {Array<('trunc'|'nearest'|'ceil')>} Candidate integer quantizers. */
export const ROUNDING = ['trunc', 'nearest', 'ceil'];
/** @type {Array<('thickness'|'center'|'opening')>} Candidate gap baselines. */
export const GAPS = ['thickness', 'center', 'opening'];
/** @type {RendererModel[]} All SCALES x ROUNDING x GAPS combinations, frozen, id = "scale:rounding:gap". */
export const MODELS = Object.freeze(SCALES.flatMap(scale => ROUNDING.flatMap(rounding => GAPS.map(gap => Object.freeze({ id: `${scale}:${rounding}:${gap}`, scale, rounding, gap })))));
const MODEL_BY_ID = new Map(MODELS.map(model => [model.id, model]));
/** Four interpretable historical controls, plus default and hedge = six UI choices.
 * The full factorial remains available to offline research; these are not equivalent models.
 */
export const EXPERT_MODELS = Object.freeze([
    'authored:trunc:thickness', 'authored:trunc:center', 'authored:nearest:center', 'authored:ceil:center',
].map(id => MODEL_BY_ID.get(id)));
/** @type {string} Historical research default; the UI resolves the community model separately. */
export const DEFAULT_ID = 'authored:trunc:thickness';
/**
 * Look up a declared renderer hypothesis by id.
 * @param {string} id - renderer hypothesis id, e.g. "authored:trunc:thickness".
 * @returns {RendererModel} the matching model.
 * @throws {Error} if no model with that id is declared.
 */
export function getModel(id) { const m = id === COMMUNITY_MODEL.id ? COMMUNITY_MODEL : MODEL_BY_ID.get(id); if (!m)
    throw new Error('Unknown renderer hypothesis.'); return m; }
function scaleForKnownModel(model, height, authoredHeight) {
    return height / ({ authored: authoredHeight, reference1080: 1080, reference720: 720 }[model.scale]);
}
/**
 * Height-to-native pixel-scale ratio for a renderer hypothesis.
 * @param {{id: string}} m - model (or object carrying a model id) to resolve.
 * @param {GameHeight} height - height to scale to.
 * @param {GameHeight} authoredHeight - authored/reference height stored with the native settings.
 * @returns {number} pixel scale ratio for that model's SCALES reference.
 */
export function scaleOf(m, height, authoredHeight) { return scaleForKnownModel(getModel(m.id), height, authoredHeight); }
/**
 * Predict rendered geometry for native settings under one renderer hypothesis.
 * @param {NativeSettings} native - native length/thickness/gap and authored height.
 * @param {GameHeight} height - height to render at.
 * @param {{id: string}} m - renderer hypothesis (or object carrying its id).
 * @returns {Geometry} predicted geometry.
 */
export function forward(native, height, m) {
    if (m.id === COMMUNITY_MODEL.id) return communityForward(native, height);
    validateNative(native);
    validateHeight(height);
    m = getModel(m.id);
    const r = scaleForKnownModel(m, height, native.authoredHeight);
    const length = quantize(native.length * r, m.rounding), width = Math.max(1, quantize(native.thickness * r, m.rounding));
    const p = quantize(native.gap * r, m.rounding);
    const near = m.gap === 'thickness' ? Math.floor(width / 2) + p : m.gap === 'center' ? p : (p - 1) / 2;
    return { length, width, near, far: near + 1, interval: length ? 2 * near + 1 : null, scale: r, model: m.id, minimumBranch: native.thickness === 0 };
}
/**
 * Normalize and validate a comparison scope (heights and matching goal).
 * @param {{oldHeight?: GameHeight, currentHeight?: GameHeight, authoredHeight?: GameHeight, goal?: ('pixels'|'screen'), outlineMode?: ('auto'|0|1|2), styleTarget?: ('static'|'family'), tShape?: ('keep'|'auto'|'on'|'off')}} [options] - partial scope; unset heights fall back to oldHeight (default 1080), then each other.
 * @returns {{oldHeight: GameHeight, currentHeight: GameHeight, authoredHeight: GameHeight, goal: ('pixels'|'screen'),
 *   outlineMode: ('auto'|0|1|2), styleTarget: ('static'|'family'), tShape: ('keep'|'auto'|'on'|'off'),
 *   corrections: boolean}} resolved scope; the last four are opt-in choices (`corrections` defaults on).
 * @throws {Error} for an unknown goal.
 */
export function scope(options = {}) {
    const oldHeight = options.oldHeight ?? 1080, currentHeight = options.currentHeight ?? oldHeight, authoredHeight = options.authoredHeight ?? currentHeight;
    [oldHeight, currentHeight, authoredHeight].forEach(validateHeight);
    const goal = options.goal ?? 'pixels';
    if (!['pixels', 'screen'].includes(goal))
        throw new Error('Unknown comparison goal.');
    // `corrections`: the community model's automatic appearance corrections; historical models ignore it.
    return { oldHeight, currentHeight, authoredHeight, goal,
        outlineMode: outlineChoice(options.outlineMode), styleTarget: styleTargetChoice(options.styleTarget),
        tShape: tShapeChoice(options.tShape),
        corrections: bool(options.corrections ?? true, 'Appearance corrections') };
}
/**
 * Resolve the old/legacy target geometry for a comparison scope, optionally overridden by a measured geometry.
 * @param {object} settings - legacy crosshair settings passed to legacyGeometry.
 * @param {{oldHeight?: GameHeight, currentHeight?: GameHeight, authoredHeight?: GameHeight, goal?: ('pixels'|'screen')}} [options] - comparison scope.
 * @param {?Geometry} [measured] - independently measured geometry to target instead of the legacy formula.
 * @returns {{legacy: Geometry, target: Geometry, options: object}} legacy geometry, the (possibly screen-scaled) target, and the resolved scope.
 * @throws {Error} if the (measured or legacy) source geometry is out of range.
 */
export function targetGeometry(settings, options = {}, measured = null) {
    const o = scope(options), legacy = legacyGeometry(settings, o.oldHeight), source = measured ?? legacy;
    for (const k of ['length', 'width', 'near', 'far'])
        finite(source[k], `Target ${k}`, -1024, 100000);
    if (source.length < 0 || source.width < 1)
        throw new Error('Target length/width is invalid.');
    const r = o.goal === 'screen' ? o.currentHeight / o.oldHeight : 1;
    const target = { ...source, ...Object.fromEntries(['length', 'width', 'near', 'far'].map(k => [k, source[k] * r])) };
    if (source.axisStart !== undefined)
        target.axisStart = finite(source.axisStart, 'Target transverse edge', -1000000, 1000000) * r;
    return { legacy, target, options: o };
}
/**
 * Counterfactual direct assignment. It is NOT a reproduction of Valve's migration code.
 * @param {{size: LegacyUnit, thickness: LegacyUnit, gap: LegacyUnit}} settings - legacy settings to truncate and clamp directly into native ranges.
 * @param {GameHeight} authoredHeight - authored height to record on the result.
 * @returns {NativeSettings} clamped native settings.
 */
export function naiveAssignment(settings, authoredHeight) {
    validateHeight(authoredHeight);
    return { length: Math.max(0, Math.min(255, Math.trunc(settings.size))), thickness: Math.max(0, Math.min(31, Math.trunc(settings.thickness))), gap: Math.max(0, Math.min(128, Math.trunc(settings.gap))), authoredHeight };
}
/**
 * Squared-error distance between two predicted geometries (near/far only compared when `b.length` > 0).
 * @param {Geometry} a - first geometry.
 * @param {Geometry} b - second geometry (defines whether near/far are compared).
 * @returns {number} sum of squared per-field differences.
 */
export function geometryError(a, b) { return (a.length - b.length) ** 2 + (a.width - b.width) ** 2 + (b.length > 0 ? ((a.near - b.near) ** 2 + (a.far - b.far) ** 2) : 0); }
/**
 * Deterministic string key for a native settings tuple.
 * @param {NativeSettings} n - native settings.
 * @returns {string} `"length/thickness/gap@authoredHeight"`.
 */
export function nativeKey(n) { return `${n.length}/${n.thickness}/${n.gap}@${n.authoredHeight}`; }
/**
 * Deterministic string key for a geometry's length/width/near/far.
 * @param {Geometry} g - geometry.
 * @returns {string} `"length/width/near/far"`.
 */
export function geometryKey(g) { return [g.length, g.width, g.near, g.far, g.rasterConvention ?? '', g.axisStart ?? ''].join('/'); }
/**
 * List conversion blockers for legacy settings outside the modeled scope. A weapon-dependent gap is not a
 * blocker: it converts with the non-weapon gap and warns `weapon-gap-dropped`.
 * @param {{style: number}} settings - legacy settings to check.
 * @returns {string[]} human-readable blocker messages; empty if in scope.
 */
export function unsupported(settings) {
    const out = [];
    const blocker = styleBlocker(settings.style);
    if (blocker) out.push(blocker);
    return out;
}
