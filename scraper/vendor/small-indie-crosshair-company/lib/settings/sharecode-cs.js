// Read-only decoder for the current `CS…` share code (build 2000922).
// Layout as described by patriqcs/cursed-crosshair-generator (MIT, commit fa88525,
// public/js/sharecode.js); attribution: THIRD_PARTY_NOTICES.md. Independent implementation.
// Both reference tools state the layout comes from the game binary; that is not verified here.
import { ALPHABET } from './sharecode.js';

export const CS_DIGITS = 44, CS_BYTES = 32, CS_VERSION = 1;

/**
 * Payload, 32 bytes, read big-endian from the base-57 number (least-significant digit first):
 *   0      checksum = sum of bytes 1..31 mod 256
 *   1      version (1)
 *   2-3    cl_crosshair_screen_height, uint16 little-endian (0 rejected, below 240 raised to 240)
 *   4      bits 0-4 style (max 9), 5 recoil, 6 dot, 7 T-style
 *   5-8    crosshair r, g, b, a        9-12 outline r, g, b, a
 *   13     bits 0-5 thickness (max 32), bits 6-7 cl_crosshair_drawoutline (max 2)
 *   14-15  gap, int16 little-endian (clamped to -3840..3840)
 *   16     length                      17 dynamic spread limit
 *   18-21  uint32 little-endian: bits 0-6 split distance, 7-13 inner alpha x100 (max 100),
 *          14-20 (outer alpha - 0.3) x100 (max 70), 21-27 split ratio x100 (max 100),
 *          28 cl_ironsight_usecrosshaircolor
 *   22     (cl_ironsight_dot_scale - 0.1) x100 (max 190)
 *   23-31  reported zero; kept in `_bytes`, not checked
 * The maxima are the reported decoder clamps.
 */
export function decodeCS(code) {
  if (typeof code !== 'string') throw new TypeError('Share code must be text.');
  code = code.trim();
  if (!/^CS[A-Za-z0-9]+$/.test(code)) throw new Error('Expected CS followed by 44 characters.');
  const digits = code.slice(2);
  const bad = [...digits].find(ch => !ALPHABET.includes(ch));
  if (bad) throw new Error(`Invalid share-code character: ${bad}.`);
  if (digits.length !== CS_DIGITS) throw new Error(`CS share code payload is not ${CS_BYTES} bytes: expected ${CS_DIGITS} characters ` +
    `after CS, got ${digits.length}.`);
  let n = 0n;
  for (const ch of [...digits].reverse()) n = n * BigInt(ALPHABET.length) + BigInt(ALPHABET.indexOf(ch));
  if (n >> BigInt(CS_BYTES * 8)) throw new Error('CS share code overflows 32 bytes; it is damaged or mistyped.');
  const b = new Array(CS_BYTES);
  for (let i = CS_BYTES - 1; i >= 0; i--) { b[i] = Number(n & 255n); n >>= 8n; }
  if (b[0] !== b.slice(1).reduce((a, x) => a + x, 0) % 256) throw new Error('CS share code checksum mismatch; it is damaged or mistyped.');
  if (b[1] !== CS_VERSION) throw new Error(`CS share code version ${b[1]} is not supported; only version ${CS_VERSION} is known.`);
  const height = b[2] | b[3] << 8;
  if (height === 0) throw new Error('CS share code has screen height 0, which the game reportedly rejects.');
  const gap = (b[14] | b[15] << 8) << 16 >> 16;
  const bits = (b[18] | b[19] << 8 | b[20] << 16 | b[21] << 24) >>> 0;
  const field = shift => (bits >>> shift) & 127;
  return {
    format: 'CS', version: b[1],
    style: Math.min(b[4] & 31, 9), recoil: !!(b[4] & 32), dot: !!(b[4] & 64), t_style: !!(b[4] & 128),
    color: { r: b[5], g: b[6], b: b[7], a: b[8] },
    outline_color: { r: b[9], g: b[10], b: b[11], a: b[12] },
    thickness: Math.min(b[13] & 63, 32), drawoutline: Math.min(b[13] >> 6, 2),
    gap: Math.max(-3840, Math.min(3840, gap)), length: b[16], spread_limit: b[17],
    split_distance: field(0), inner_alpha: Math.min(field(7), 100) / 100,
    outer_alpha: (Math.min(field(14), 70) + 30) / 100, split_ratio: Math.min(field(21), 100) / 100,
    ironsight_use_crosshair_color: !!(bits >>> 28 & 1), ironsight_dot_scale: (Math.min(b[22], 190) + 10) / 100,
    screen_height: Math.max(height, 240),
    _bytes: b,
  };
}

/** A one-line summary of decoded current settings, for messages; not an export path. */
export function csSummary(s) {
  return [`length ${s.length}`, `thickness ${s.thickness}`, `gap ${s.gap}`, `style ${s.style}`, `dot ${Number(s.dot)}`,
    `T ${Number(s.t_style)}`, `outline ${s.drawoutline}`, `color ${s.color.r} ${s.color.g} ${s.color.b} ${s.color.a}`,
    `screen height ${s.screen_height}`].join(', ');
}

/** Thrown by the importer for a `CS…` code: it already holds new settings, so there is nothing to convert. */
export class CurrentShareCodeError extends Error {
  constructor(settings) {
    super(`This is a current CS2 crosshair code; it already uses the new settings: ${csSummary(settings)}. No conversion needed.`);
    this.name = 'CurrentShareCodeError';
    this.code = 'current-share-code';
    this.settings = settings;
  }
}
