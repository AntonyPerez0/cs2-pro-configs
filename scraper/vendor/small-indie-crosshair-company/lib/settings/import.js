import { decodeLegacy } from './sharecode.js';
import { decodeCS, CurrentShareCodeError } from './sharecode-cs.js';
import { GAME_DEFAULTS_2000908, LEGACY_SETTING_KEYS, parseLegacyCFG, clampOldRanges } from './cfg.js';

/**
 * Dispatch pasted legacy text to the share-code or allowlisted-CFG parser, whichever it is.
 * @param {string} text - trimmed user input: a `CSGO-` share code or a legacy `.cfg` block.
 * @param {object} [base] - settings to merge unspecified CFG fields onto; defaults to the pre-update game
 *   defaults GAME_DEFAULTS_2000908 (a note then lists the filled cvars). Share codes are complete and ignore it.
 * @returns {object} decoded/parsed legacy settings.
 * @throws {Error} if the text is neither a valid share code nor an allowlisted CFG block;
 *   a `CurrentShareCodeError` (`code: 'current-share-code'`, decoded `settings`) for a valid `CS…` code.
 */
export function parseLegacyText(text, base = GAME_DEFAULTS_2000908) {
  return parseLegacyTextWithNotes(text, base).config;
}

/** Like parseLegacyText, but also returns the parser notes (ignored, repeated, clamped or defaulted cvars) and
 * `assigned`, the setting keys the input set (a share code stores every one). */
export function parseLegacyTextWithNotes(text, base = GAME_DEFAULTS_2000908) {
  if (typeof text === 'string') text = text.trim();
  // A current `CS…` code already holds new settings; say so instead of converting.
  // Legacy codes are `CSGO-` plus dashes; a `CS` code's 44 characters may begin with "GO".
  // Anything else starting with CSGO (no dashes, lower case) is a damaged legacy code, not a 46-character CS code.
  if (/^CSGO/i.test(text) && !/^CS[A-Za-z0-9]{44}$/.test(text)) {
    const notes = [], config = decodeLegacy(text);
    return {config: clampOldRanges(config, notes, ['outline_width', 'inner_alpha', 'outer_alpha', 'split_ratio']), notes,
      assigned: [...LEGACY_SETTING_KEYS]};
  }
  if (/^CS[A-Za-z0-9]+$/.test(text)) throw new CurrentShareCodeError(decodeCS(text));
  return parseLegacyCFG(text, base);
}
