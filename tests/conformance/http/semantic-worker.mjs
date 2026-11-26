import { createInterface } from 'node:readline';
import { expectedDomainRejection } from './semantic-preconditions.mjs';

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    const result = await expectedDomainRejection(JSON.parse(line));
    process.stdout.write(JSON.stringify({ result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
  }
}
