/** Exact inverse of a monotone quantized dimension, including every tied plateau. */
import { communityDimension } from '../geometry/community.js';

export function communityAxis(wanted, ratio, max, minimum = 0) {
  const ideal = wanted / ratio, cache = new Map();
  const drawn = value => {
    if (!cache.has(value)) cache.set(value, communityDimension(value, ratio));
    return cache.get(value);
  };
  const lowerBound = predicate => {
    let low = minimum, high = max + 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (predicate(drawn(middle))) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  const crossing = lowerBound(value => value >= wanted);
  const adjacent = [crossing - 1, crossing].filter(value => value >= minimum && value <= max);
  const loss = Math.min(...adjacent.map(value => (drawn(value) - wanted) ** 2));
  const pixels = [...new Set(adjacent.filter(value => (drawn(value) - wanted) ** 2 === loss).map(drawn))];
  const equivalents = [];
  for (const pixel of pixels) {
    const start = lowerBound(value => value >= pixel), end = lowerBound(value => value > pixel);
    for (let value = start; value < end; value++) equivalents.push(value);
  }
  let value = equivalents[0];
  for (const candidate of equivalents) if (Math.abs(candidate - ideal) < Math.abs(value - ideal)) value = candidate;
  return { value, loss, tie: Math.abs(value - ideal), ideal, idealInRange: ideal >= 0 && ideal <= max,
    equivalents, evaluations: cache.size };
}
