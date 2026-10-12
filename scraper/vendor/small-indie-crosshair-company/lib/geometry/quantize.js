/** The one integer quantizer shared by the manual and automatic conversion models. */

/**
 * Quantize a continuous pixel value to an integer under one rounding rule.
 * @param {number} x - value to quantize.
 * @param {('trunc'|'nearest'|'ceil')} rule - rounding rule.
 * @returns {number} quantized integer.
 */
export function quantize(x, rule) {
  return rule === 'nearest' ? Math.floor(x + .5) : rule === 'ceil' ? Math.ceil(x) : Math.trunc(x);
}
