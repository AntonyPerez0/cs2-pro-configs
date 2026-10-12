import { MODELS, forward } from './renderer.js';
import { drawingEdges, RASTER_CONVENTION, RAW_EDGE_CONVENTION } from '../geometry/raster.js';
import { entropy, normalizeLogs, wilson, mean, logSumExp } from './statistics.js';
import { validateMeasurements, grouped, activeFeatures } from './observations.js';

/** Sensitivity assumptions, not empirically learned noise hyperparameters. */
export const NOISE_MODEL = Object.freeze({ id: 'gaussian-student-contamination-v1', contamination: .05, studentScale: 8, degreesOfFreedom: 4 });

function predictedPixels(observation, model) {
  const geometry = forward(observation.native, observation.currentHeight, model);
  return { ...geometry, ...drawingEdges(geometry), axisStart: 0 - Math.floor(geometry.width / 2) };
}

export function residualSquared(observation, model) {
  const p = predictedPixels(observation, model);
  return activeFeatures(observation).reduce((sum, key) => sum + ((p[key] - observation.observed[key]) / observation.sigma) ** 2, 0);
}

/** Multivariate t mixture has bounded tail influence. Common sigma normalization cancels across models. */
export function robustLogLikelihood(squared, dimensions) {
  if (!Number.isFinite(squared) || squared < 0 || ![2, 4].includes(dimensions)) throw new Error('Invalid likelihood residual or dimension.');
  const { contamination: epsilon, studentScale: scale, degreesOfFreedom: nu } = NOISE_MODEL;
  const gammaRatio = dimensions === 2 ? Math.log(2) : Math.log(6); // Gamma(3)/Gamma(2), Gamma(4)/Gamma(2)
  const normal = -.5 * dimensions * Math.log(2 * Math.PI) - .5 * squared;
  const student = gammaRatio - .5 * dimensions * Math.log(nu * Math.PI) - dimensions * Math.log(scale)
    - .5 * (nu + dimensions) * Math.log1p(squared / (nu * scale * scale));
  return logSumExp([Math.log1p(-epsilon) + normal, Math.log(epsilon) + student]);
}

function trainPosterior(groups) {
  const logs = MODELS.map(() => -Math.log(MODELS.length));
  let allModelConflict = false;
  for (const group of groups) {
    const errors = MODELS.map(m => group.map(x => residualSquared(x, m)));
    if (Math.min(...errors.map(mean)) > 25) allModelConflict = true;
    errors.forEach((losses, i) => {
      logs[i] += mean(losses.map((squared, j) => robustLogLikelihood(squared, activeFeatures(group[j]).length)));
    });
  }
  return { weights: normalizeLogs(logs), allModelConflict };
}

function evaluateHoldouts(groups, weights) {
  const mapIndex = weights.indexOf(Math.max(...weights));
  return groups.map(group => {
    const correct = MODELS.map(model => group.every(x => {
      const predicted = predictedPixels(x, model);
      const fields = x.observed.axisStart === undefined ? activeFeatures(x) : [...activeFeatures(x), 'axisStart'];
      return fields.every(k => Math.abs(predicted[k] - x.observed[k]) <= .5);
    }));
    const predictiveMass = correct.reduce((sum, exact, i) => sum + Number(exact) * weights[i], 0);
    return { group: group[0].captureGroup, topModelCorrect: correct[mapIndex], predictiveMass,
      logScore: -Math.log(Math.max(predictiveMass, 1e-300)) };
  });
}

export function posterior(records = []) {
  const canonical = validateMeasurements(records), native = canonical.filter(x => x.kind === 'native-user');
  const training = grouped(native.filter(x => x.role === 'calibration'));
  const holdouts = grouped(native.filter(x => x.role === 'holdout'));
  const unique = [...training, ...holdouts].reduce((sum, group) => sum + group.length, 0);
  const { weights, allModelConflict } = trainPosterior(training), holdoutTests = evaluateHoldouts(holdouts, weights);
  const validation = wilson(holdoutTests.filter(x => x.topModelCorrect).length, holdoutTests.length);
  return { weights, calibrationGroups: training.length, holdoutGroups: holdouts.length,
    syntheticIgnored: records.length - native.length, duplicateNativeMeasurementsIgnored: native.length - unique,
    mode: training.length ? 'user-measured-conditional-posterior' : 'prior-only-sensitivity',
    entropyBits: entropy(weights), allModelConflict, nativeMatchProbability: null, noiseModel: NOISE_MODEL,
    edgeComparison: { predicted: RASTER_CONVENTION, observed: RAW_EDGE_CONVENTION },
    likelihoodScope: 'Length, width and active inner edges only; measured transverse origin is also checked on holdouts.',
    validation: { ...validation, meanLogScore: mean(holdoutTests.map(x => x.logScore)),
      scope: 'MAP drawn-core geometry within 0.5 px on user-supplied holdout groups, not individual conversion confidence.' },
    holdoutTests, models: MODELS.map((m, i) => ({ ...m, weight: weights[i] })),
    warning: 'Conditional weights depend on the hypothesis set, robust noise assumptions and user-provided evidence. Synthetic previews and legacy presets never update them.' };
}
