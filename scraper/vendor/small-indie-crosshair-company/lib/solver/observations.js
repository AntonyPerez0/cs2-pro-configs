import { BUILD } from './renderer.js';
import { COMMUNITY_MODEL } from '../geometry/community.js';
import { validateNative, NATIVE_RANGES_2000922, GAP_CVAR_RANGE_2000922 } from '../settings/native.js';
import { height, finite, text } from '../settings/validation.js';
export const FEATURES = ['length', 'width', 'near', 'far'];
export const activeFeatures = observation => observation.observed.length > 0 ? FEATURES : ['length', 'width'];

function requiredText(value, label, limit = 128) {
  text(value, label, limit);
  if (!value.trim()) throw new Error(`${label} cannot be empty.`);
  return value;
}

const STALE = 'Build 2000918 measurements predate the build 2000922 renderer change; re-capture on 2000922.';
const stale = build => { if (build === '2000918') throw new Error(STALE); };
/** Later builds with no crosshair change: 2000924 (7193ca8, source ledger S19) changed only the workshop
 * cvar whitelist, so its captures count as captures of the build they render like. Records keep their own build. */
export const RENDERER_EQUIVALENT_BUILDS = Object.freeze({ 2000924: '2000922' });
const rendererBuild = build => Object.hasOwn(RENDERER_EQUIVALENT_BUILDS, build ?? '') ? RENDERER_EQUIVALENT_BUILDS[build] : build;

function canonicalRecord(record, build) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid measurement record.');
  const id = requiredText(record.id, 'Measurement id'), captureGroup = requiredText(record.captureGroup, 'Capture group');
  if (!['native-user', 'synthetic'].includes(record.kind) || !['calibration', 'holdout'].includes(record.role))
    throw new Error('Declare measurement kind and role.');
  stale(record.build);
  if (rendererBuild(record.build) !== build) throw new Error(`Measurement is outside target build ${build}.`);
  if (record.kind === 'native-user' && (!/^[a-f0-9]{64}$/i.test(record.captureSha256 ?? '') || record.attested !== true))
    throw new Error('Native measurements require a capture SHA-256 and explicit user attestation.');
  if (build === COMMUNITY_MODEL.build)
    validateNative(record.native, { ...NATIVE_RANGES_2000922, gap: GAP_CVAR_RANGE_2000922 });
  else validateNative(record.native);
  height(record.currentHeight);
  finite(record.sigma, 'Measurement noise', .25, 32);
  const observed = Object.fromEntries(FEATURES.map(key => [key, finite(record.observed?.[key], `Observed ${key}`, -256, 8192)]));
  if (record.observed?.axisStart !== undefined)
    observed.axisStart = finite(record.observed.axisStart, 'Observed transverse edge', -8192, 8192);
  if (observed.width < 1 || observed.length < 0) throw new Error('Observed width/length is invalid.');
  const native = Object.fromEntries(['length', 'thickness', 'gap', 'authoredHeight'].map(k => [k, record.native[k]]));
  return { id, kind: record.kind, role: record.role, build: record.build, captureGroup, captureSha256: record.captureSha256?.toLowerCase(),
    attested: record.attested === true, native, currentHeight: record.currentHeight, sigma: record.sigma, observed };
}

function readingKey(x) {
  return JSON.stringify([x.build, x.role, Object.values(x.native), x.currentHeight, activeFeatures(x).map(k => x.observed[k]),
    x.observed.axisStart, x.sigma]);
}

export function validateMeasurements(records, build = BUILD) {
  if (build !== null && ![BUILD, COMMUNITY_MODEL.build].includes(build)) throw new Error('Unsupported measurement build.');
  if (!Array.isArray(records) || records.length > 256) throw new Error('Measurements must be an array of at most 256 records.');
  const ids = new Set(), roles = new Map(), captures = new Map();
  return records.map(record => {
    const targetBuild = build ?? rendererBuild(record?.build);
    stale(record?.build);
    if (![BUILD, COMMUNITY_MODEL.build].includes(targetBuild)) throw new Error('Unsupported measurement build.');
    const x = canonicalRecord(record, targetBuild);
    if (ids.has(x.id)) throw new Error('Each measurement needs a unique bounded id.');
    ids.add(x.id);
    const keys = ['group:' + x.captureGroup];
    if (x.captureSha256) keys.push('hash:' + x.captureSha256);
    for (const key of keys) {
      if (roles.has(key) && roles.get(key) !== x.role) throw new Error('Capture/group leakage: calibration and holdout must be disjoint.');
      roles.set(key, x.role);
    }
    if (x.kind === 'native-user') {
      const reading = readingKey(x), old = captures.get(x.captureSha256);
      if (old && old !== reading) throw new Error('Conflicting readings/settings for the same native capture hash. Resolve the conflict before fitting.');
      captures.set(x.captureSha256, reading);
    }
    return x;
  });
}

function linked(a, b) {
  return a.captureGroup === b.captureGroup || Boolean(a.captureSha256 && a.captureSha256 === b.captureSha256);
}

/** Preserve transitive capture/session dependence BEFORE duplicate removal. */
export function grouped(records) {
  const groups = [];
  for (const row of records) {
    const matches = groups.filter(group => group.some(other => linked(other, row)));
    if (!matches.length) { groups.push([row]); continue; }
    const target = matches[0];
    target.push(row);
    for (const group of matches.slice(1)) { target.push(...group); groups.splice(groups.indexOf(group), 1); }
  }
  return groups.map(group => [...new Map(group.map(x => [x.captureSha256 + ':' + readingKey(x), x])).values()]);
}
