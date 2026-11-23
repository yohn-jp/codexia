import { join } from 'node:path';
import { readRegularFile } from './common.mjs';

const fixtureMetrics = [
  'fixture_scene_ms',
  'fixture_scene_pg_round_trip_ms',
  'fixture_stream_ms',
  'fixture_stream_first_byte_ms',
];

export async function assertSyntheticSamples(output) {
  const summary = JSON.parse(await readRegularFile(join(output, 'k6-summary.json')));
  const iterations = summary?.metrics?.iterations?.count;
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('k6 evidence must report at least one completed iteration');
  }
  // In both fixture profiles, each completed iteration must contribute one
  // observation to each of the four successful-response trends.
  for (const name of fixtureMetrics) {
    if (summary.metrics[name]?.count !== iterations) {
      throw new Error(`k6 evidence: ${name} summary count must equal ${iterations}`);
    }
  }

  const counts = new Map(fixtureMetrics.map(name => [name, 0]));
  const samples = await readRegularFile(join(output, 'k6-samples.jsonl'));
  for (const line of samples.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const point = JSON.parse(line);
    if (point?.type !== 'Point' || !counts.has(point.metric)) continue;
    const value = point.data?.value;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`k6 evidence: ${point.metric} has an invalid raw sample`);
    }
    counts.set(point.metric, counts.get(point.metric) + 1);
  }
  for (const [name, count] of counts) {
    if (count !== iterations) {
      throw new Error(`k6 evidence: ${name} has ${count} raw samples; expected ${iterations}`);
    }
  }
}
