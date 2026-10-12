/** Shared input validation. Never coerce empty strings, NaN or infinities into settings. */
export function finite(value, name, min = -10000, max = 10000) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${name} must be a finite number from ${min} to ${max}.`);
  return value;
}
export function integer(value, name, min, max) {
  finite(value, name, min, max);
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer.`);
  return value;
}
export function height(value) { return integer(value, 'Game height', 240, 16384); }
export function bool(value, name) {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be true or false.`);
  return value;
}
export function text(value, name, limit = 256) {
  if (typeof value !== 'string' || value.length > limit) throw new TypeError(`${name} must be text of at most ${limit} characters.`);
  return value;
}
export function decimal(value, name) {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))
    throw new TypeError(`${name} must be a decimal number.`);
  return finite(Number(value), name);
}
export function cleanNumber(value) { return Object.is(value, -0) ? 0 : value; }
export function schemaObject(value, keys, name = 'Object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new TypeError(`${name}: unknown field ${key}.`);
  return value;
}
