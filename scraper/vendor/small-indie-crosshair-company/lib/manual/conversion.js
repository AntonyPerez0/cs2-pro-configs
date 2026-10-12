import { legacyGeometry } from '../geometry/legacy.js';
import { finite, height as validHeight } from '../settings/validation.js';
import { validateNative, nativeCommands, outlineChoice, effectiveOutlineMode, optionWarnings, legacyOutlineExtent,
  OUTLINE_ONLY_NOTE, styleBlocker } from '../settings/native.js';
import { outlineWarnings, legacySettingWarnings, colorIndexWarning } from '../settings/warnings.js';
import { commandLine } from '../settings/command-line.js';
import { RASTER_CONVENTION, RAW_EDGE_CONVENTION, outlineOnly } from '../geometry/raster.js';
// Shared with the automatic quant-static-v5 family, which also allows 'ceil'; validateModel
// below restricts this model's rounding to 'trunc'|'nearest' before any value reaches it.
import { quantize } from '../geometry/quantize.js';

/** @typedef {number} LegacyUnit */ // raw cl_crosshairsize/thickness/gap value, unitless, may be fractional
/** @typedef {number} GameHeight */ // integer in-game resolution height, pixels, 240-16384
/** @typedef {number} IntSetting */ // integer new cvar value (length/thickness/gap)
/** @typedef {number} Px */ // device/game pixels, may be fractional (e.g. measured gap baseline)
/** @typedef {number} IntPx */ // integer game pixels after quantization
/** @typedef {{gapBaseline: ('thickness'|'center'|'measured'), rounding: ('trunc'|'nearest'), farDelta: number, measuredBase: Px, measuredStep: number}} ModelConfig */

/**
 * Manual lab. It is deliberately NOT unified with the automatic `quant-static-v5` family:
 * this model has a `measured` gap branch the quant family does not, and the quant family
 * has `ceil` and `opening` which this lab does not. Unifying them is a later patch with its
 * own model id. See docs/engineering/archive/v0.4-conversion-improvement-plan.md §5.2.
 */
/** @type {string} Model id for this manual-lab conversion family. */
export const MODEL_VERSION = 'conditional-static-v4';
/** @type {string} CS2 build this model is calibrated against. */
export const TARGET_BUILD = '2000914';
/** Build-specific: stationary static output still selects style 4 on build 2000914. */
export const STATIC_STYLE_ON_BUILD_2000914 = 4;
/** @type {ModelConfig} Default conditional-static-v4 model: thickness-relative gap, truncating quantizer. */
export const DEFAULT_MODEL = Object.freeze({
  gapBaseline: 'thickness', rounding: 'trunc', farDelta: 1, measuredBase: 0, measuredStep: 1,
});
/**
 * Throw if a model config names an unknown gap baseline/rounding rule or an out-of-range parameter.
 * @param {ModelConfig} m - model to validate.
 * @returns {void}
 */
export function validateModel(m) {
  if (!['thickness','center','measured'].includes(m.gapBaseline)) throw new Error('Unknown gap baseline.');
  if (!['trunc','nearest'].includes(m.rounding)) throw new Error('Unknown rounding rule.');
  finite(m.farDelta,'Far-side displacement',0,4);
  finite(m.measuredBase,'Measured gap intercept',-128,256);
  finite(m.measuredStep,'Measured gap slope',0.001,100);
}
/**
 * Predict new-renderer geometry for stored native settings at a given height.
 * @param {{length: IntSetting, thickness: IntSetting, gap: IntSetting, authoredHeight: GameHeight}} n - native cvar values.
 * @param {GameHeight} currentHeight - height to predict at.
 * @param {ModelConfig} [model] - conversion model; defaults to DEFAULT_MODEL.
 * @returns {{model: string, rasterConvention: string, height: GameHeight, length: IntPx, width: IntPx, near: Px, far: Px, interval: (Px|null), gapOffset: Px, scale: number, minimumBranch: boolean}} predicted geometry.
 */
export function predictedGeometry(n, currentHeight, model = DEFAULT_MODEL) {
  validateNative(n); validHeight(currentHeight); validateModel(model);
  const ratio = currentHeight / n.authoredHeight;
  const length = Math.max(0, quantize(n.length * ratio, model.rounding));
  const width = Math.max(1, quantize(n.thickness * ratio, model.rounding));
  const base = model.gapBaseline === 'thickness' ? Math.floor(width/2) : model.gapBaseline === 'center' ? 0 : model.measuredBase;
  // Measured intercept/slope are CURRENT-resolution pixels for this exact calibration scope.
  const step = model.gapBaseline === 'measured' ? model.measuredStep : ratio;
  const near = base + (model.gapBaseline === 'measured' ? n.gap * step : quantize(n.gap * step, model.rounding));
  return { model: MODEL_VERSION, rasterConvention: model.gapBaseline === 'measured' ? RAW_EDGE_CONVENTION : RASTER_CONVENTION, height: currentHeight, length, width, near,
    far: near + model.farDelta, interval: length > 0 ? 2 * near + model.farDelta : null,
    gapOffset: near-base, scale: ratio, minimumBranch: n.thickness===0 };
}

/** Search legal settings. Never disguise an out-of-range exact candidate as an exact match. */
function solve(target, raw, max, predict) {
  let best = null;
  for (let value = 0; value <= max; value++) {
    const pixels = predict(value), error = Math.abs(pixels-target);
    const preference = Math.abs(value-raw);
    if (!best || error < best.error || (error === best.error && preference < best.preference))
      best = { value, pixels, error, preference };
  }
  return { raw, value: best.value, predicted: best.pixels, error: best.error,
    inRange: raw >= 0 && raw <= max, exactWithinModel: best.error < 1e-9 };
}
function conversionScope(options) {
  const oldHeight = options.oldHeight ?? 1080;
  const currentHeight = options.currentHeight ?? oldHeight;
  const authoredHeight = options.authoredHeight ?? currentHeight;
  validHeight(oldHeight); validHeight(currentHeight); validHeight(authoredHeight);
  const goal = options.goal ?? 'pixels';
  if (!['pixels','screen'].includes(goal)) throw new Error('Unknown matching goal.');
  const model = { ...DEFAULT_MODEL, ...options.model }; validateModel(model);
  return {oldHeight,currentHeight,authoredHeight,goal,model,outlineMode:outlineChoice(options.outlineMode)};
}

function conversionMessages(settings, model, old, target, predicted, solutions, outlineOption = 'auto') {
  const {length,thickness,gap}=solutions;
  const warnings = [], blockers = [];
  if (settings.style !== undefined && styleBlocker(settings.style)) blockers.push(styleBlocker(settings.style));
  if (settings.thickness > 0 && thickness.value === 0) warnings.push('The nearest discrete width uses the zero-minimum branch; future-resolution behavior may differ from the positive legacy setting.');
  if (old.length === 0 && !settings.dot)
    warnings.push(outlineOnly(old, settings, legacyOutlineExtent(settings)) ? OUTLINE_ONLY_NOTE
      : 'No arms and no dot: this configuration has no visible colored geometry.');
  if (settings.recoil) warnings.push('Preview is the at-rest crosshair only. Follow-recoil behavior is not simulated.');
  const outline = effectiveOutlineMode(settings, outlineOption);
  const shared = [...outlineWarnings(settings, { outlineMode: outlineOption }), colorIndexWarning(settings),
    ...legacySettingWarnings(settings)];
  // The lab has no shape check; its own illustrative-border note below covers the full outline.
  warnings.push(...shared.filter(w => w && w.code !== 'outline-replacement-unverified').map(w => w.text));
  warnings.push(...optionWarnings(settings, { outlineMode: outlineOption }).map(w => w.text));
  if (outline === 1) warnings.push('Outline width has no verified native replacement; preview uses a one-pixel illustrative border.');
  if (settings.thickness === 0 && target.width !== 1) warnings.push('Preserving the zero-thickness minimum conflicts with the requested screen-relative thickness.');
  if (model.gapBaseline === 'measured') warnings.push('Measured gap parameters are valid only at the recorded build, heights and effective thickness. This UI does not independently verify them.');
  for (const [name, result] of Object.entries({length, thickness, ...(old.length > 0 ? {gap} : {})})) {
    if (!result.inRange) warnings.push(`${name}: ideal value ${result.raw.toFixed(4)} is outside the documented range; showing the nearest legal candidate, not an exact conversion.`);
    if (!result.exactWithinModel) warnings.push(`${name}: ${result.error.toFixed(4)} pixel residual under the selected model.`);
  }
  const farError = old.length > 0 ? predicted.far-target.far : 0;
  if (Math.abs(farError)>1e-9) warnings.push('Far-side alignment differs under the selected centering convention. A gap change alone may not fix both sides.');
  if (old.near < 0) warnings.push('Legacy arms cross the reference origin. Negative-gap overlap may be unrepresentable.');
  return {warnings,blockers,farError};
}

/**
 * Solve legal new-cvar settings that reproduce (or best-approximate) the old geometry.
 * @param {object} settings - legacy crosshair settings (size, thickness, gap, and optional style/weapon_gap/dot/recoil/outline flags).
 * @param {{oldHeight?: GameHeight, currentHeight?: GameHeight, authoredHeight?: GameHeight, goal?: ('pixels'|'screen'), model?: object}} [options] - conversion scope; `model` is merged onto DEFAULT_MODEL.
 * @returns {object} conversion result: version, status, targetBuild, options, old/target geometry, solved native settings, predicted geometry, per-dimension solutions, farError, geometryExact, warnings, blockers.
 */
export function convert(settings, options = {}) {
  const {oldHeight,currentHeight,authoredHeight,goal,model,outlineMode:outlineMode_}=conversionScope(options);
  const old = legacyGeometry(settings,oldHeight);
  const factor = goal === 'screen' ? currentHeight/oldHeight : 1;
  const target = { length:old.length*factor, width:old.width*factor, near:old.near*factor, far:old.far*factor };
  const ratio = currentHeight/authoredHeight;
  const length = solve(target.length, target.length/ratio,255,v => quantize(v*ratio,model.rounding));
  const thickness = settings.thickness === 0
    ? {raw:0,value:0,predicted:1,error:Math.abs(1-target.width),inRange:true,exactWithinModel:target.width===1}
    : solve(target.width,target.width/ratio,31,v=>Math.max(1,quantize(v*ratio,model.rounding)));
  const width = thickness.predicted;
  const base = model.gapBaseline === 'thickness' ? Math.floor(width/2) : model.gapBaseline === 'center' ? 0 : model.measuredBase;
  const step = model.gapBaseline === 'measured' ? model.measuredStep : ratio;
  const midpoint=(target.near+target.far-model.farDelta)/2;
  const gap=solve(midpoint,(midpoint-base)/step,128,v=>base+(model.gapBaseline==='measured'?v*step:quantize(v*step,model.rounding)));
  gap.error=Math.abs(gap.predicted-target.near);
  gap.exactWithinModel=gap.error<1e-9;

  const native = {length:length.value,thickness:thickness.value,gap:gap.value,authoredHeight};
  const predicted = predictedGeometry(native,currentHeight,model);
  const {warnings,blockers,farError}=conversionMessages(settings,model,old,target,predicted,{length,thickness,gap},outlineMode_);
  const geometryExact = length.exactWithinModel && thickness.exactWithinModel &&
    (old.length===0 || (gap.exactWithinModel && Math.abs(farError)<1e-9));
  return {version:MODEL_VERSION,status:'conditional-not-game-validated',targetBuild:TARGET_BUILD,
    options:{oldHeight,currentHeight,authoredHeight,goal,model,outlineMode:outlineMode_},old,target,native,predicted,
    solutions:{length,thickness,gap},farError,geometryExact,warnings,blockers};
}

/**
 * Render the solved (or manually overridden) native settings as one `;`-separated CS2 console line.
 * @param {object} result - a `convert()` result (uses `options`, `blockers`, `native`).
 * @param {object} settings - legacy settings, for color/flags shared with `nativeCommands`.
 * @param {?{length: IntSetting, thickness: IntSetting, gap: IntSetting, authoredHeight: GameHeight}} [nativeOverride] - manual candidate values, if editing away from the solved defaults.
 * @returns {string} one command line without comments (warnings stay on the result).
 * @throws {Error} if `result.blockers` is nonempty.
 */
export function exportCFG(result,settings,nativeOverride=null) {
  if (result.blockers.length) throw new Error(result.blockers.join(' '));
  const n=nativeOverride??result.native, o=conversionScope(result.options);
  return commandLine(nativeCommands(settings,n,o.outlineMode==='auto'?{}:{outlineMode:o.outlineMode}));
}
