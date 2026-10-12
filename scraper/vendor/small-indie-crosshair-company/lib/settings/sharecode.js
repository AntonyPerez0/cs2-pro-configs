// Legacy v1 layout adapted from akiver/csgo-sharecode, MIT.
// Attribution and license: THIRD_PARTY_NOTICES.md, licenses/akiver-MIT.txt.
import { integer, finite, bool } from './validation.js';
export const ALPHABET = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789';
const signed = b => b >= 128 ? b - 256 : b;
/** Old `CSGO-` codes: 25 base-57 digits, least-significant first, give 18 bytes. */
export const DIGITS = 25, BYTES = 18;
const sum = (bytes, end = bytes.length) => bytes.slice(1, end).reduce((a,b) => a+b, 0) % 256;
/** The game's own example codes since 2000913 are version 3; the payload layout changed between
 * 2000913 and 2000921 while the version byte stayed 3. */
export const VERSION_3_EXAMPLES = Object.freeze({
  '2000913': 'CSGO-frCAy-PRXin-PY8Kj-wDTUo-TWAwO',
  '2000921': 'CSGO-y9Qw8-sCzPb-jORFu-ov6L8-GwMXL', // unchanged on 2000922
});
export const NEW_FORMAT_V3_ERROR = 'This is a new-format code (version 3). This converter needs an old crosshair; ' +
  'paste the console lines or an old code.';
export function decodeLegacy(code) {
  if (typeof code !== 'string') throw new TypeError('Share code must be text.');
  code = code.trim();
  if (!/^CSGO(?:-[A-Za-z0-9]+)+$/.test(code)) throw new Error('Expected CSGO- followed by five groups of five characters.');
  const digits = code.slice(5).replaceAll('-', '');
  const bad = [...digits].find(ch => !ALPHABET.includes(ch));
  if (bad) throw new Error(`Invalid share-code character: ${bad}.`);
  if (digits.length !== DIGITS) {
    throw new Error(`Share code payload is not ${BYTES} bytes: expected ${DIGITS} characters, got ${digits.length}.`);
  }
  if (!/^CSGO(?:-[A-Za-z0-9]{5}){5}$/.test(code)) throw new Error('Expected CSGO- followed by five groups of five characters.');
  let n = 0n;
  for (const ch of [...digits].reverse()) n = n * BigInt(ALPHABET.length) + BigInt(ALPHABET.indexOf(ch));
  if (n >= 1n << 144n) throw new Error('Share code overflows 18 bytes; it is damaged or mistyped.');
  const bytes = new Array(BYTES);
  for (let i = BYTES - 1; i >= 0; i--) { bytes[i] = Number(n & 255n); n >>= 8n; }
  // Version-3 codes are reported to checksum only bytes 1..15 (cursed-crosshair-generator).
  const valid = bytes[0] === sum(bytes) || (bytes[1] >= 3 && bytes[0] === sum(bytes, 16));
  if (!valid) throw new Error('Share code checksum mismatch; it is damaged or mistyped.');
  if (bytes[1] === 3) throw new Error(NEW_FORMAT_V3_ERROR);
  if (bytes[1] !== 1) throw new Error(`Share code version ${bytes[1]} is not supported; only old version-1 codes convert. ` +
    'Paste the console lines instead.');
  return {
    // Size is 13 bits x10: low 8 bits in byte 14, high 5 bits in bits 0-4 of byte 15.
    version: 1, size: (((bytes[15] & 31) << 8) | bytes[14]) / 10, thickness: bytes[12] / 10,
    gap: signed(bytes[2]) / 10, dot: !!(bytes[13] & 16), style: (bytes[13] & 15) >> 1,
    outline: !!(bytes[10] & 8), outline_width: bytes[3] / 2,
    // Share codes store the width in 0.5 steps, so 0 stands for any width below 0.5 (issue #11).
    outline_width_rounded: bytes[3] === 0,
    alpha_enabled: !!(bytes[13] & 64), alpha: bytes[7], color: bytes[10] & 7,
    rgb: bytes.slice(4,7), weapon_gap: !!(bytes[13] & 32), recoil: !!(bytes[8] & 128),
    t_style: !!(bytes[13] & 128), fixed_gap: signed(bytes[9]) / 10,
    split_distance: bytes[8] & 7, inner_alpha: (bytes[10] >> 4) / 10,
    outer_alpha: (bytes[11] & 15) / 10, split_ratio: (bytes[11] >> 4) / 10,
    // Preserve undecoded/reserved bits for a lossless same-code re-encode.
    _bytes: bytes,
  };
}
function tick(v, mul, name, min, max) {
  finite(v, name, min, max);
  const scaled = v * mul;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-7) throw new Error(`${name} is not representable in a legacy share code.`);
  return Math.round(scaled);
}
/** Plain note on what an old share code can keep of the outline thickness, or null. Codes store it in 0.5 steps
 * (0 to 3): another width has no code (`representable` false), and a width below 0.5 reads back as a rounded 0,
 * which converts to the half outline even where a typed 0 drew no outline. */
export function legacyCodeOutlineNote(c) {
  const width = c.outline_width;
  if (!c.outline || !Number.isFinite(width)) return null;
  if (Math.abs(width * 2 - Math.round(width * 2)) > 1e-7) return { representable: false,
    text: `Old share codes store outline thickness in 0.5 steps (0, 0.5, 1 … 3), so outline thickness ${width} has no ` +
      'code. Copy the console commands instead, or set the outline thickness to a 0.5 step.' };
  if (width < .5) return { representable: true, text: 'Codes store outline thickness in 0.5 steps, so this code reads ' +
    'back as a rounded 0: a thin outline below 0.5, which converts to the half outline' +
    (width === 0 && !c.outline_width_rounded ? ', although a typed 0 drew no outline.' : '.') };
  return null;
}
/** Re-encode settings as a `CSGO-` code. The format stores outline width in 0.5 steps, so a width in [0, 0.5)
 * (including a CFG-typed 0, which drew no outline) re-decodes as 0 "rounded" and maps to the half outline. */
export function encodeLegacy(c) {
  for (const key of ['dot','outline','recoil','weapon_gap','alpha_enabled','t_style']) bool(c[key],key);
  const bytes = c._bytes?.length === 18 ? [...c._bytes] : new Array(18).fill(0);
  bytes.forEach((v,i) => integer(v, `Byte ${i}`, 0,255));
  bytes[1] = 1;
  bytes[2] = tick(c.gap,10,'Gap',-12.8,12.7) & 255;
  bytes[3] = tick(c.outline_width,2,'Outline width',0,3);
  if (!Array.isArray(c.rgb) || c.rgb.length !== 3) throw new Error('RGB must contain three integers.');
  c.rgb.forEach((v,i) => bytes[4+i] = integer(v,'RGB',0,255));
  bytes[7] = integer(c.alpha,'Alpha',0,255);
  bytes[8] = (bytes[8] & 120) | integer(c.split_distance ?? 3,'Split distance',0,7) | (Number(c.recoil) << 7);
  bytes[9] = tick(c.fixed_gap ?? 3,10,'Fixed gap',-12.8,12.7) & 255;
  bytes[10] = integer(c.color,'Color',0,7) | (Number(c.outline) << 3) | (tick(c.inner_alpha ?? 0,10,'Inner alpha',0,1) << 4);
  bytes[11] = tick(c.outer_alpha ?? 1,10,'Outer alpha',0,1) | (tick(c.split_ratio ?? 1,10,'Split ratio',0,1) << 4);
  bytes[12] = tick(c.thickness,10,'Thickness',0,25.5);
  bytes[13] = (bytes[13] & 1) | (integer(c.style,'Style',0,7) << 1) | (Number(c.dot) << 4) |
    (Number(c.weapon_gap) << 5) | (Number(c.alpha_enabled) << 6) | (Number(c.t_style) << 7);
  const sizeTicks = tick(c.size,10,'Size',0,819.1);
  bytes[14] = sizeTicks & 255;
  bytes[15] = (bytes[15] & 224) | (sizeTicks >> 8);
  bytes[0] = bytes.slice(1).reduce((a,b)=>a+b,0) % 256;
  let n = bytes.reduce((v,b) => (v << 8n) | BigInt(b),0n), out = '';
  for (let i=0;i<25;i++) { out += ALPHABET[Number(n % BigInt(ALPHABET.length))]; n /= BigInt(ALPHABET.length); }
  if (n !== 0n) throw new Error('Code exceeds the share-code envelope.');
  return 'CSGO-' + out.match(/.{5}/g).join('-');
}
