import { createHash } from 'node:crypto';

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

export function digestEvidence(value) {
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
}

