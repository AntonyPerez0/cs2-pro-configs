/** Held-out checks of one fixed reconstruction; capture groups, never rows, are the units. */
import { COMMUNITY_MODEL, communityForward } from '../geometry/community.js';
import { NATIVE_RANGES_2000922 as RANGES } from '../settings/native.js';
import { validateMeasurements, grouped, activeFeatures } from './observations.js';
import { wilson } from './statistics.js';

export function communityEvidence(records) {
  const canonical = validateMeasurements(records, COMMUNITY_MODEL.build);
  const native = canonical.filter(row => row.kind === 'native-user');
  // The cvar accepts -3840..3840; the static-cross reconstruction covers only 0..128.
  const unmodeled = row => row.native.gap < RANGES.gap.min || row.native.gap > RANGES.gap.max;
  // Out-of-domain rows can bridge sessions through a shared capture hash. Preserve that dependence before filtering.
  const groups = grouped(native), unique = groups.flat();
  const outside = unique.filter(unmodeled);
  const modeledGroups = groups.map(group => group.filter(row => !unmodeled(row))).filter(group => group.length);
  const calibration = modeledGroups.filter(group => group[0].role === 'calibration');
  const holdouts = modeledGroups.filter(group => group[0].role === 'holdout');
  const check = row => {
    if (unmodeled(row))
      return { id: row.id, role: row.role, build: row.build, outsideModelDomain: true,
        reason: row.native.gap < 0 ? 'negative-gap' : 'gap-above-static-range' };
    const predicted = communityForward(row.native, row.currentHeight);
    predicted.axisStart = 0 - Math.ceil(predicted.width / 2);
    const fields = row.observed.axisStart === undefined ? activeFeatures(row) : [...activeFeatures(row), 'axisStart'];
    const residuals = Object.fromEntries(fields.map(key => [key, predicted[key] - row.observed[key]]));
    return { id: row.id, role: row.role, build: row.build, residuals,
      matches: Object.values(residuals).every(value => Math.abs(value) <= .5) };
  };
  const holdoutTests = holdouts.map(group => ({ group: group[0].captureGroup,
    matches: group.every(row => check(row).matches), measurements: group.length }));
  const validation = wilson(holdoutTests.filter(group => group.matches).length, holdouts.length);
  const measurementChecks = [...calibration, ...holdouts].flat().concat(outside).map(check);
  return { measurementChecks, gapCapturesUnmodeled: outside.length, calibrationGroups: calibration.length,
    holdoutGroups: holdouts.length, holdoutTests,
    syntheticIgnored: canonical.length - native.length,
    duplicateNativeMeasurementsIgnored: native.length - measurementChecks.length,
    validation: { ...validation,
      scope: 'Declared measured fields within 0.5 px, grouped by user capture/session. Independence is user-attested; ' +
        'the interval is not an individual conversion probability or proof of native pixels.' } };
}
