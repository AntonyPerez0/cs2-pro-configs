import { decimal, cleanNumber } from './validation.js';
import { decodeLegacy } from './sharecode.js';
import { NEW_CVARS, NEW_CVARS_2000922, OUTLINE_COLOR_CVARS } from './cvars.js';
import { OLD_OUTLINE_MAX } from './native.js';
import { cfgStatements } from './statements.js';
export const DEFAULT_SETTINGS = Object.freeze({...decodeLegacy('CSGO-aNQn2-upV5w-M8dOd-OOwcf-2pFKO')});
/** Pre-update CS2 defaults: build 2000908, SteamDatabase/GameTracking-CS2 commit d8e2c7a,
 * DumpSource2/convars.txt (source ledger S13). A pasted CFG block's unspecified cvars take these values. */
export const GAME_DEFAULTS_2000908 = Object.freeze({
  version: 1, size: 3.9, thickness: 0.6, gap: -2.2, dot: false, style: 2, outline: true, outline_width: 1,
  outline_width_rounded: false, alpha_enabled: true, alpha: 200, color: 5, rgb: Object.freeze([0, 255, 0]),
  weapon_gap: true, recoil: true, t_style: false, fixed_gap: 3, split_distance: 3, inner_alpha: 0, outer_alpha: 1,
  split_ratio: 1,
});
/** Names introduced by the 2000914 update and extended on 2000922 (outline colour, fill opacity, spread limit).
 * They are not legacy settings and must not be imported as one. */
const NEW_BUILD_NAMES = new Set([...[NEW_CVARS, NEW_CVARS_2000922, OUTLINE_COLOR_CVARS]
  .flatMap(group => Object.values(group)).map(cvar => cvar.name), 'cl_crosshaircolor_a', 'cl_crosshair_dynamic_spread_limit']);
/** Error for current-game input, naming the cvars (or values) that triggered it. */
export const newBuildError = found => new Error(`New-build cvars cannot be imported as legacy settings: ${found.slice(0, 4).join(', ')}` +
  `${found.length > 4 ? ` and ${found.length - 4} more` : ''}. The input already looks like current-game settings, which ` +
  'need no conversion. Paste the old cl_crosshairsize / thickness / gap block, or edit the proposed values.');
/** Old cvars the current game still stores, hidden, after the update (with the current style, 0..9). */
const HIDDEN_LEFTOVERS = new Set(['size', 'thickness', 'alpha', 'style']);
/** A paste that sets only those cvars and a style the old game never had (6 or more) is a current-game dump. */
export const hiddenLeftoversError = found => new Error(`This looks like hidden leftovers from the current game: ${found.join(', ')}. ` +
  'The current game still stores the old cl_crosshairsize, cl_crosshairthickness and cl_crosshairalpha unseen (for a ' +
  'fresh install 3.9, 0.6 and 200), and the style is a current-game style, so these values do not describe the ' +
  'crosshair you used before the update. Paste your old cl_crosshairsize / thickness / gap block or your old CSGO- share code.');
const FIELDS = {
  cl_crosshairsize:'size',cl_crosshairthickness:'thickness',cl_crosshairgap:'gap',
  cl_crosshairstyle:'style',cl_crosshairdot:'dot',cl_crosshair_t:'t_style',
  cl_crosshair_drawoutline:'outline',cl_crosshair_outlinethickness:'outline_width',
  cl_crosshair_recoil:'recoil',cl_crosshairgap_useweaponvalue:'weapon_gap',
  cl_crosshairalpha:'alpha',cl_crosshairusealpha:'alpha_enabled',cl_crosshaircolor:'color',
  cl_fixedcrosshairgap:'fixed_gap',cl_crosshair_dynamic_splitdist:'split_distance',
  cl_crosshair_dynamic_splitalpha_innermod:'inner_alpha',cl_crosshair_dynamic_splitalpha_outermod:'outer_alpha',
  cl_crosshair_dynamic_maxdist_splitratio:'split_ratio',cl_crosshaircolor_r:'r',cl_crosshaircolor_g:'g',cl_crosshaircolor_b:'b',
};
/** Legacy cvars (e.g. from a `find crosshair` dump) that never change the crosshair shape; noted and skipped. */
const IGNORED=new Set(['cl_grenadecrosshair_keepusercrosshair',
  ...['decoy','explosive','fire','flash','smoke'].flatMap(k=>['cl_grenadecrosshair_','cl_grenadecrosshairdelay_'].map(p=>p+k)),
  'cl_ironsight_usecrosshaircolor','cl_ironsight_dot_scale','cl_crosshair_friendly_warning',
  'cl_show_observer_crosshair','cl_sniper_show_inaccuracy','cl_crosshair_sniper_width',
  'cl_crosshair_sniper_show_normal_inaccuracy','cl_observed_bot_crosshair',
  'cl_teamid_overhead_fade_near_crosshair','cl_draw_only_deathnotices','crosshair']);
const NUM='[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
// A statement is `name value`, `"name"<tab>"value"` or console echo `name = value ( def. "0" )`, optionally after a `]` or
// `[Console]` prompt. Names are case-insensitive like the console. The value is one token; non-decimal tokens get decimal()'s message.
const STATEMENT=/^(?:"([^"\s=]+)"|([^"\s=]+))(?:\s*=\s*|\s+)(?:"([^"\s]*)"|([^"\s(]+))(?:\s*\(.*)?$/i;
const PROMPT=/^(?:\[console\]|\])\s*/i;
/** Console commands that are skipped, never run (any name starting with `+` or `-` is one too). */
const COMMANDS=new Set(['bind','unbind','unbindall','alias','exec','echo','host_writeconfig','toggle','incrementvar']);
/** Console flag words that `find crosshair` prints after the value (CS2 build 2000922 dump and the CS:GO list). */
const FLAG_WORDS=new Set(['client','server','archive','per_user','user','userinfo','replicated','cheat','release','ss','ss_added',
  'clientdll','norecord','protected','hidden','devonly','developmentonly','sponly','vconsole_set_focus','launcher','notify',
  'execute_per_tick']);
/** `name value client archive …` loses everything from the first flag word on; only a flag word as the third token counts. */
function withoutFlagColumns(s){
  const tokens=s.split(/\s+/);
  // The description after the flags is free text ("0 = off" included), but never a quote or a cvar name (a second assignment).
  const tail=tokens.slice(2),plain=tail.every(t=>!/"/.test(t)&&!/^cl_/i.test(t));
  return tokens.length>=3&&tokens[1]!=='='&&FLAG_WORDS.has(tokens[2].toLowerCase())&&plain?`${tokens[0]} ${tokens[1]}`:s;
}
const LITERAL=new RegExp(`^(?:${NUM}|true|false)$`);
const BOOL=new Set(['dot','t_style','outline','recoil','weapon_gap','alpha_enabled']);
/** Old cvar bounds from the CS2 pre-update dump (build 2000908, S13); the old game clamped to them. */
export const OLD_RANGES = Object.freeze({
  alpha: [0, 255], r: [0, 255], g: [0, 255], b: [0, 255], outline_width: [0, OLD_OUTLINE_MAX],
  inner_alpha: [0, 1], outer_alpha: [0.3, 1], split_ratio: [0, 1],
});
/** Old `cl_crosshair_outlinethickness` maximum (old source and the CS2 pre-update dump: 0..3); the game clamped above it. */
export const OUTLINE_WIDTH_MAX = OLD_RANGES.outline_width[1];
export const CLAMP_NOTE = (cvar, value, to) => `${cvar} ${value} clamped to ${to}` +
  `${cvar === 'cl_crosshair_outlinethickness' && to === OUTLINE_WIDTH_MAX ? ' (the old maximum)' : ''} as the old game did.`;
/** Every setting key a legacy input can assign, sorted: what a share code (which stores them all) assigns. */
export const LEGACY_SETTING_KEYS = Object.freeze([...new Set(Object.values(FIELDS))].sort());
const CVAR_OF = Object.fromEntries(Object.entries(FIELDS).map(([cvar, key]) => [key, cvar]));
const read = (config, key) => ['r','g','b'].includes(key) ? config.rgb['rgb'.indexOf(key)] : config[key];
const write = (config, key, value) => { if (['r','g','b'].includes(key)) config.rgb['rgb'.indexOf(key)] = value; else config[key] = value; };
/** Clamp bounded old cvars to their old range with an import note each. Zero outline width stays zero.
 * `keys` limits the check (a CFG checks what it set; a share code checks its stored fields). */
export function clampOldRanges(config, notes, keys = Object.keys(OLD_RANGES)) {
  const out = {...config, rgb: [...config.rgb]};
  for (const key of keys) {
    const value = read(out, key), [min, max] = OLD_RANGES[key];
    if (typeof value !== 'number' || (value >= min && value <= max)) continue;
    const to = value < min ? min : max;
    notes.push(CLAMP_NOTE(CVAR_OF[key], value, to)); write(out, key, to);
  }
  return out;
}
const REPEATED_NOTE = counts => 'Repeated cvars, last assignment used: ' +
  [...counts].map(([cvar, n]) => `${cvar} (${n} times)`).join(', ') + '.';
const DEFAULT_LABELS = [['size','size'],['thickness','thickness'],['gap','gap'],['style','style'],['dot','dot'],['t_style','T'],
  ['outline','outline'],['outline_width','outline thickness'],['alpha','alpha'],['alpha_enabled','usealpha'],['color','colour'],
  ['rgb','rgb'],['recoil','recoil'],['weapon_gap','useweaponvalue']];
const shown = value => typeof value === 'boolean' ? Number(value) : Array.isArray(value) ? value.join('/') : value;
/** Import-note prefix for the cvars a partial paste did not set (filled from GAME_DEFAULTS_2000908). */
export const DEFAULTS_NOTE_PREFIX = 'Not in the paste, game defaults used: ';
function defaultsNote(seen, config) {
  // RGB only matters for the custom colours 5 to 7.
  const unset = key => key === 'rgb' ? config.color >= 5 && !['r','g','b'].some(k => seen.has(k)) : !seen.has(key);
  const filled = DEFAULT_LABELS.filter(([key]) => unset(key))
    .map(([key, label]) => `${label} ${shown(GAME_DEFAULTS_2000908[key])}`);
  return filled.length ? `${DEFAULTS_NOTE_PREFIX}${filled.join(', ')}.` : null;
}
/** Bounds, whole numbers and flags as the old game read them, per assigned key (notes for every change). */
function oldValue(cvar, key, v, notes) {
  // The old game read flags and indices as GetInt(), which drops the fraction (GetBool is !!GetInt).
  if ((BOOL.has(key) || key === 'style' || key === 'color') && !Number.isInteger(v)) {
    const whole = Math.trunc(v) || 0;
    notes.push(`${cvar} ${v} is not a whole number; the old game read ${whole} (fraction dropped).`);
    v = whole;
  }
  if (BOOL.has(key)) {
    if (v !== 0 && v !== 1) notes.push(`${cvar} ${v} is not 0 or 1; any non-zero value is on, so 1 is used.`);
    return v !== 0;
  }
  if ((key === 'size' || key === 'thickness') && v < 0)
    throw new Error(`${cvar} ${v} is negative; the old ${key} is 0 or more.`);
  if (key === 'color' && !(Number.isInteger(v) && v >= 0 && v <= 7))
    throw new Error(`${cvar} ${v} is not an old colour index; use 0 to 4 for a preset or ` +
      '5 for your own RGB (6 and 7 come from share codes and also use the RGB).');
  if (['alpha','r','g','b'].includes(key) && !Number.isInteger(v)) {
    const whole = Math.trunc(v) || 0;
    notes.push(`${cvar} ${v} is not a whole number; the old game stored ${whole} (fraction dropped).`);
    return whole;
  }
  return v;
}
/** Statement text without its console prompt tag. */
const unprompt = raw => raw.trim().replace(PROMPT, '').trim();
/** Note for skipped lines: `bind (3), alias (1)`, most frequent first, then by name. */
const skippedNote = counts => 'Skipped ' + [...counts.values()].reduce((a, n) => a + n, 0) +
  ' line(s) that are not old crosshair settings: ' +
  [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name, n]) => `${name} (${n})`).join(', ') + '.';
/** Parse a tiny data-only allowlist. Crosshair cvars are read as data; binds, exec, aliases and other
 * commands or cvars are skipped with a note, never run. Anything else that is not `name value` is rejected.
 * Unspecified cvars come from `base` (default: the pre-update game defaults, with a note listing them).
 * `assigned` lists the setting keys the text set (sorted, unique), so callers can tell chosen values from filled ones. */
export function parseLegacyCFG(input, base=GAME_DEFAULTS_2000908) {
  if(typeof input!=='string'||input.length>32768) throw new Error('Configuration must be at most 32 KiB of text.');
  const config={...base,rgb:[...base.rgb]},seen=new Set(),notes=[],ignored=[],repeated=new Map(),last=new Map(),skipped=new Map();
  const statements=cfgStatements(input);
  // A current `find crosshair` dump is new-build anywhere in the text, so check before any value error.
  const found=[...new Set(statements.map(raw=>/^"?(cl_[a-z0-9_]+)/i.exec(unprompt(raw))?.[1]?.toLowerCase())
    .filter(n=>NEW_BUILD_NAMES.has(n)))];
  if(found.length)throw newBuildError(found);
  let count=0;
  for(const raw of statements) {
    let s=unprompt(raw);
    // Empty text and the braces / section titles of a .vcfg file carry no setting; neither do the `- description`
    // lines of `find` output or a line of flag words only (` client archive ss`).
    if(!s||/^[{}]$|^"[^"]*"$|^-\s/.test(s)||s.split(/\s+/).every(word=>FLAG_WORDS.has(word.toLowerCase())))continue;
    const skip=n=>skipped.set(n,(skipped.get(n)??0)+1);
    const head=/^"?([^\s"=]+)/.exec(s)?.[1].toLowerCase();
    if(head&&(COMMANDS.has(head)||/^[+-]/.test(head))){skip(head);continue;}
    s=withoutFlagColumns(s);
    const m=STATEMENT.exec(s),name=(m?.[1]??m?.[2])?.toLowerCase(),word=m&&(m[3]??m[4]);
    if(m&&/^[a-z_][a-z0-9_]*$/.test(name)&&!Object.hasOwn(FIELDS,name)&&!IGNORED.has(name)){skip(name);continue;}
    if(m&&IGNORED.has(name)&&LITERAL.test(word)){ignored.push(name);continue;}
    if(!m||!Object.hasOwn(FIELDS,name))
      throw new Error('Only allowlisted legacy crosshair assignments are accepted; no executable console scripts.');
    const key=FIELDS[name],flag=word==='true'||word==='false';
    if(flag&&!BOOL.has(key))throw new Error(`${name} must be a number.`);
    const v=flag?+(word==='true'):cleanNumber(decimal(word,name));
    if(seen.has(key))repeated.set(name,(repeated.get(name)??1)+1);
    seen.add(key);count++;
    // The old game read the flag as GetInt(), so 2.5 is the half outline too.
    if(key==='outline'&&Math.trunc(v)===2)
      throw newBuildError(['cl_crosshair_drawoutline 2 (the half outline exists only in the current game)']);
    last.delete(key);last.set(key,[name,v]);
  }
  if(!count)throw new Error('No crosshair assignments found.');
  const style=last.get('style')?.[1];
  if(style>=6&&[...seen].every(key=>HIDDEN_LEFTOVERS.has(key)))
    throw hiddenLeftoversError([...last.values()].map(([name,v])=>`${name} ${v}`));
  // The last assignment of each cvar counts, read as the old game read it.
  for(const [key,[name,v]] of last){
    write(config,key,oldValue(name,key,v,notes));
    if(key==='outline_width')config.outline_width_rounded=false;
  }
  if(repeated.size)notes.push(REPEATED_NOTE(repeated));
  if(ignored.length)notes.push(`Ignored ${ignored.length} cvar(s) that do not change the crosshair shape: ${ignored.join(', ')}.`);
  if(skipped.size)notes.push(skippedNote(skipped));
  const clamped=clampOldRanges(config,notes,Object.keys(OLD_RANGES).filter(key=>seen.has(key)));
  const filled=base===GAME_DEFAULTS_2000908?defaultsNote(seen,clamped):null;
  if(filled)notes.push(filled);
  return {config:clamped,notes,assigned:[...seen].sort()};
}
