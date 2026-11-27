import { createHash } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { type FileHandle, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DocumentId,
  type OpenWorkExportRows,
  type Persistence,
  PersistenceError,
  type ProjectId,
} from '@codexia/persistence-contracts';
import { ZipWriter } from '@zip.js/zip.js';
import schema from './open-work-export-v1.schema.json' with { type: 'json' };
import { omitPortableModuleRecord, safeSettings, unresolvedSchema, WorkArchiveError } from './work-archive.js';

export { WorkArchiveError };

export const OPEN_WORK_EXPORT_BYTES = 128 * 1024 * 1024;
export const OPEN_WORK_EXPORT_GENERATE_MS = 60_000;
export const OPEN_WORK_EXPORT_SEND_MS = 300_000;
const MAX_ENTRIES = 32_000;
const ORDINAL_WIDTH = String(MAX_ENTRIES).length;
const ZIP_FORMAT = 'codexia-open-work/v1';
const encoding = new TextEncoder();
const readme =
  '# Codexia open work export\n\n' +
  'Extract this ZIP with a standard ZIP utility. All Markdown and JSON are UTF-8.\n' +
  'manifest.json describes paths and integrity. schema.json defines the JSON files.\n' +
  'Numbered manuscript folders follow the outline order among siblings. Long paths may be flattened, with full hierarchy in manifest.json.\n' +
  'manifest.json records document hierarchy, order and head paths. metadata/project.json provides full document metadata. history/revisions.json lists every retained revision.\n' +
  'Deleted documents are listed separately from the current manuscript in the metadata.\n' +
  'Knowledge Markdown is a reading view of knowledge/graph.json.\n';

type FileProof = { path: string; bytes: number; sha256: string };
type Revision = Omit<OpenWorkExportRows['revisions'], 'projectId' | 'markdown' | 'authorId'> & { path: string; authorId: 'owner' | null };
type Document = OpenWorkExportRows['documents'];

function limit(): never {
  throw new WorkArchiveError(413, 'OPEN_WORK_EXPORT_LIMIT', 'The complete ZIP exceeds the export limit');
}

function incomplete(): never {
  throw new WorkArchiveError(409, 'OPEN_WORK_EXPORT_INCOMPLETE', 'A required work export record is missing or inconsistent');
}

function readablePathSegment(title: string, id: string): string {
  const clean = title
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '_')
    .replace(/^[ .]+|[ .]+$/gu, '');
  const label = Array.from(clean).slice(0, 20).join('') || 'document';
  const segment = label + '-' + id;
  // Windows reserves device names even when followed by an extension.
  return /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *\./iu.test(segment) ? '_' + segment : segment;
}

function manuscriptPath(
  document: Document,
  documents: ReadonlyMap<DocumentId, Document>,
  segments: ReadonlyMap<DocumentId, string>,
): string {
  const seen = new Set<DocumentId>();
  const parts: string[] = [];
  let current: Document | undefined = document;
  while (current) {
    if (seen.has(current.id)) incomplete();
    seen.add(current.id);
    const segment = segments.get(current.id);
    if (!segment) incomplete();
    parts.push(segment);
    if (current.parentId === null) break;
    current = documents.get(current.parentId);
    if (!current) incomplete();
  }
  const leaf = parts[0]!;
  const full = parts.reverse().join('/');
  return 'manuscript/' + (Buffer.byteLength(full) <= 170 ? full : leaf) + '/index.md';
}

async function* jsonArray(values: Iterable<unknown> | AsyncIterable<unknown>): AsyncIterable<string> {
  yield '[';
  let separator = '';
  for await (const value of values) {
    yield separator + JSON.stringify(value);
    separator = ',';
  }
  yield ']\n';
}

async function* jsonFields(fields: Record<string, Iterable<unknown> | AsyncIterable<unknown>>): AsyncIterable<string> {
  yield '{';
  let separator = '';
  for (const [key, rows] of Object.entries(fields)) {
    yield separator + JSON.stringify(key) + ':';
    yield* jsonArray(rows);
    separator = ',';
  }
  yield '}\n';
}

async function createScratchZip() {
  const directory = await mkdtemp(join(tmpdir(), 'codexia-work-export-'));
  let file: FileHandle | undefined;
  let linked = true;
  const removeDirectory = () => rm(directory, { recursive: true, force: true });
  const dispose = async () => {
    try {
      await file?.close();
    } finally {
      if (linked) await removeDirectory();
    }
  };
  try {
    file = await open(join(directory, 'work.zip'), 'wx+', 0o600);
    if (process.platform !== 'win32') {
      // Unlink before writing manuscript bytes. If the process stops, the OS reclaims the file with its descriptor.
      await removeDirectory();
      linked = false;
    }
    return { file, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function generateOpenWorkZip(
  persistence: Persistence,
  projectId: ProjectId,
  signal: AbortSignal,
  maxBytes = OPEN_WORK_EXPORT_BYTES,
): Promise<{ bytes: number; createReadStream: () => ReadStream; dispose: () => Promise<void> }> {
  signal.throwIfAborted();
  try {
    const { file, dispose } = await createScratchZip();
    let zipBytes = 0;
    try {
      let totalBytes = 0;
      let entryCount = 0;
      const files: FileProof[] = [];
      const output = new WritableStream<Uint8Array>({
        async write(chunk) {
          signal.throwIfAborted();
          zipBytes += chunk.byteLength;
          if (zipBytes > maxBytes) limit();
          await file.writeFile(chunk);
        },
      });
      const zip = new ZipWriter(output, { zip64: false, bufferedWrite: false, useWebWorkers: false });
      const add = async (name: string, source: Iterable<string> | AsyncIterable<string>, track = true) => {
        if (++entryCount > MAX_ENTRIES) limit();
        const sha = createHash('sha256');
        let bytes = 0;
        const chunks = (async function* () {
          for await (const text of source) {
            signal.throwIfAborted();
            const chunk = encoding.encode(text);
            bytes += chunk.byteLength;
            totalBytes += chunk.byteLength;
            if (totalBytes > maxBytes) limit();
            sha.update(chunk);
            yield chunk;
          }
        })();
        const input = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const item = await chunks.next();
            if (item.done) controller.close();
            else controller.enqueue(item.value);
          },
          async cancel() {
            await chunks.return(undefined);
          },
        });
        await zip.add(name, input, { signal, zip64: false });
        const proof = { path: name, bytes, sha256: sha.digest('hex') };
        if (track) files.push(proof);
        return proof;
      };

      await persistence.read(
        async reader => {
          const scanRows = reader.scanOpenWorkExport?.bind(reader);
          if (!scanRows) throw new WorkArchiveError(503, 'PERSISTENCE_UNAVAILABLE', 'Open work export is unavailable');
          const scan = <K extends keyof OpenWorkExportRows>(section: K) => scanRows(projectId, section, maxBytes);
          const iterator = scan('project')[Symbol.asyncIterator]();
          const { value: project } = await iterator.next();
          await iterator.return?.();
          if (!project) throw new WorkArchiveError(404, 'WORK_NOT_FOUND', 'Work was not found');

          const documents = new Map<DocumentId, Document>();
          const manuscriptSegments = new Map<DocumentId, string>();
          const siblingCounts = new Map<DocumentId | null, number>();
          let documentMetadataBytes = 0;
          for await (const document of scan('documents')) {
            documentMetadataBytes += Buffer.byteLength(JSON.stringify(document));
            if (documents.size >= MAX_ENTRIES || documentMetadataBytes > maxBytes) limit();
            documents.set(document.id, document);
            if (document.deletedAt === null) {
              const ordinal = (siblingCounts.get(document.parentId) ?? 0) + 1;
              siblingCounts.set(document.parentId, ordinal);
              const prefix = String(ordinal).padStart(ORDINAL_WIDTH, '0');
              manuscriptSegments.set(document.id, prefix + '-' + readablePathSegment(document.title, document.id));
            }
          }
          const revisions: Revision[] = [];
          const headPaths = new Map<DocumentId, string>();
          const retainedRevisionIds = new Set<string>();
          let excludedAuthorAttribution = 0;
          for await (const revision of scan('revisions')) {
            const document = documents.get(revision.documentId);
            if (!document) incomplete();
            const current = document.deletedAt === null && document.headRevisionId === revision.id;
            const path = current
              ? manuscriptPath(document, documents, manuscriptSegments)
              : 'history/documents/' + (document.deletedAt ? 'deleted/' : '') + document.id + '/' + revision.id + '.md';
            if (document.headRevisionId === revision.id) headPaths.set(document.id, path);
            const proof = await add(path, [revision.markdown]);
            if (proof.sha256 !== revision.sha256) incomplete();
            retainedRevisionIds.add(revision.documentId + '/' + revision.id);
            if (revision.authorId !== 'owner') excludedAuthorAttribution++;
            revisions.push({
              id: revision.id,
              documentId: revision.documentId,
              parentRevisionId: revision.parentRevisionId,
              createdAt: revision.createdAt,
              authorId: revision.authorId === 'owner' ? 'owner' : null,
              sha256: revision.sha256,
              path,
            });
          }
          for (const document of documents.values()) if (!headPaths.has(document.id)) incomplete();

          const omittedSettings: string[] = [];
          const projectFields = JSON.stringify({ ...project, settings: safeSettings(project.settings, omittedSettings) });
          await add(
            'metadata/project.json',
            (async function* () {
              yield projectFields.slice(0, -1) + ',"documents":';
              function* documentMetadata() {
                for (const { projectId: _id, ...row } of documents.values()) yield row;
              }
              yield* jsonArray(documentMetadata());
              yield '}\n';
            })(),
          );
          await add('history/revisions.json', jsonArray(revisions));

          let excludedModules = 0;
          let unresolved = { anchors: [] as unknown[], mentions: [] as unknown[], assertionEvidence: [] as unknown[] };
          const portableModules = async function* () {
            for await (const { moduleId, key, value } of scan('moduleRecords')) {
              if (moduleId === 'core.portable.archive' && key === 'unresolved-evidence') {
                const found = unresolvedSchema.safeParse(value);
                if (!found.success) incomplete();
                unresolved = found.data;
              } else if (omitPortableModuleRecord(moduleId, key, value)) {
                excludedModules++;
              } else {
                yield { moduleId, key, value };
              }
            }
          };
          await add('metadata/module-records.json', jsonArray(portableModules()));

          const portableRows = async function* <K extends 'nodes' | 'aliases' | 'relations' | 'anchors' | 'mentions' | 'assertions'>(
            section: K,
          ) {
            for await (const { projectId: _id, ...row } of scan(section)) yield row;
          };
          await add(
            'knowledge/graph.json',
            jsonFields({
              nodes: portableRows('nodes'),
              aliases: portableRows('aliases'),
              relations: portableRows('relations'),
            }),
          );
          for await (const node of scan('nodes')) {
            const heading = node.name.replace(/[\r\n]/gu, ' ');
            await add('knowledge/' + readablePathSegment(node.name, node.id) + '.md', [
              '# ' + heading + '\n\n',
              'Type: ' + node.type + '\n\n',
              'Status: ' + node.status + '\n',
            ]);
          }
          const anchors = async function* () {
            for await (const { projectId: _id, ...anchor } of scan('anchors')) {
              yield { ...anchor, revisionIncluded: retainedRevisionIds.has(anchor.documentId + '/' + anchor.revisionId) };
            }
          };
          await add(
            'knowledge/evidence.json',
            (async function* () {
              yield '{"anchors":';
              yield* jsonArray(anchors());
              yield ',"mentions":';
              yield* jsonArray(portableRows('mentions'));
              yield ',"assertions":';
              yield* jsonArray(portableRows('assertions'));
              yield ',"assertionEvidence":';
              yield* jsonArray(scan('assertionEvidence'));
              yield ',"unresolved":' + JSON.stringify(unresolved) + '}\n';
            })(),
          );
          let excludedAuthority = 0;
          for await (const { count } of scan('omittedAuthority')) excludedAuthority = count;
          await add('README.md', [readme]);
          await add('schema.json', [JSON.stringify(schema) + '\n']);
          await add(
            'manifest.json',
            [
              JSON.stringify({
                format: ZIP_FORMAT,
                projectId,
                snapshotVersion: project.version,
                documents: [...documents.values()].map(({ id, parentId, kind, orderKey, headRevisionId, deletedAt }) => {
                  const path = headPaths.get(id);
                  if (!path || !headRevisionId) incomplete();
                  return { id, parentId, kind, orderKey, headRevisionId, deletedAt, path };
                }),
                excludedCounts: {
                  settings: omittedSettings.length,
                  moduleRecords: excludedModules,
                  authorityRecords: excludedAuthority,
                  authorAttribution: excludedAuthorAttribution,
                },
                files,
              }) + '\n',
            ],
            false,
          );
        },
        { signal, statementTimeoutMs: OPEN_WORK_EXPORT_GENERATE_MS },
      );
      await zip.close();
      signal.throwIfAborted();
      return { bytes: zipBytes, createReadStream: () => file.createReadStream({ autoClose: false, start: 0 }), dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  } catch (error) {
    if (error instanceof PersistenceError && error.code === 'export_limit') limit();
    if (error instanceof PersistenceError && error.code === 'unavailable')
      throw new WorkArchiveError(503, 'PERSISTENCE_UNAVAILABLE', 'PostgreSQL persistence is not ready');
    throw error;
  }
}
