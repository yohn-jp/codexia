import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface MigrationIdentity {
  version: string;
  checksum: string;
}

export interface MigrationFile extends MigrationIdentity {
  sql: string;
}

export async function readMigrationSet(directory: string): Promise<readonly MigrationFile[]> {
  const filenames = (await readdir(directory))
    .filter((filename) => /^\d+[-\w]*\.sql$/u.test(filename))
    .sort();
  if (filenames.length === 0) throw new Error("No packaged PostgreSQL migrations found");
  return Promise.all(filenames.map(async (version) => {
    const sql = await readFile(path.join(directory, version), "utf8");
    return { version, sql, checksum: createHash("sha256").update(sql, "utf8").digest("hex") };
  }));
}

/** Exact set equality; a newer database is just as incompatible as an older one. */
export function assertMigrationSet(expected: readonly MigrationIdentity[], applied: readonly MigrationIdentity[]): void {
  const checksums = new Map<string, string>();
  for (const row of applied) {
    if (checksums.has(row.version)) throw new Error(`Duplicate applied migration ${row.version}`);
    checksums.set(row.version, row.checksum.trim());
  }
  for (const migration of expected) {
    const checksum = checksums.get(migration.version);
    if (checksum === undefined) throw new Error(`Missing applied migration ${migration.version}`);
    if (checksum !== migration.checksum) throw new Error(`Applied migration ${migration.version} has changed`);
    checksums.delete(migration.version);
  }
  if (checksums.size !== 0) throw new Error(`Unexpected applied migration ${checksums.keys().next().value}`);
}

/** Stable release identity of the exact migration ledger, independent of row order. */
export function migrationSetFingerprint(migrations: readonly MigrationIdentity[]): string {
  if (migrations.length === 0) throw new Error("Empty migration set");
  const identities = new Map<string, string>();
  for (const { version, checksum } of migrations) {
    if (!/^\d+[-\w]*\.sql$/u.test(version) || !/^[a-f0-9]{64}$/u.test(checksum)) {
      throw new Error("Invalid migration identity");
    }
    if (identities.has(version)) throw new Error(`Duplicate migration identity ${version}`);
    identities.set(version, checksum);
  }
  const pairs = [...identities.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `sha256:${createHash("sha256").update(JSON.stringify(pairs), "utf8").digest("hex")}`;
}
