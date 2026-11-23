import { splitManuscriptMarkdown } from "@codexia/contracts/manuscript";
import { assertProjectPath, SNAPSHOT_READ_MANY_LIMIT, type ModuleActionContext, type NativeStoryDocument, type SnapshotId, type SnapshotReader } from "@codexia/contracts";

export type PublishingScope = "all" | "volume" | "chapter";
export type ShareScopeKind = "project" | "volume" | "chapter" | "scene";
export type PublishingOrder = number | string;

export interface PublishingScene {
  id: string;
  title: string;
  body: string;
  path: string;
  volumeId: string;
  chapterId: string;
  order?: PublishingOrder;
}

export interface PublishingChapter {
  id: string;
  title: string;
  order?: PublishingOrder;
  scenes: PublishingScene[];
}

export interface PublishingVolume {
  id: string;
  title: string;
  order?: PublishingOrder;
  chapters: PublishingChapter[];
}

export interface PublishingProject {
  title: string;
  subtitle?: string;
  volumes: PublishingVolume[];
  rootScenes?: PublishingScene[];
}

export interface ShareScope {
  kind: ShareScopeKind;
  id: string;
}

export interface PublicScene {
  id: string;
  title: string;
  body: string;
}

interface CoreTreeScene { id: string; title: string }
interface CoreTreeChapter { id: string; title: string; scenes: CoreTreeScene[] }
interface CoreTreeVolume { id: string; title: string; chapters: CoreTreeChapter[] }
interface CoreTree { title: string; volumes: CoreTreeVolume[] }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nodeTitle(data: Record<string, unknown>, fallback: string): string {
  for (const candidate of [data.title, data.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function nodeOrder(data: Record<string, unknown>): PublishingOrder | undefined {
  if (typeof data.order === "number" && Number.isFinite(data.order)) return data.order;
  if (typeof data.order === "string" && data.order.length > 0) return data.order;
  return undefined;
}

function compareOrdered(left: { id: string; title: string; order?: PublishingOrder }, right: { id: string; title: string; order?: PublishingOrder }): number {
  if (left.order !== undefined && right.order !== undefined) {
    const order = typeof left.order === "number" && typeof right.order === "number"
      ? left.order - right.order
      : String(left.order) < String(right.order) ? -1 : String(left.order) > String(right.order) ? 1 : 0;
    return order || left.id.localeCompare(right.id);
  }
  if (left.order !== undefined) return -1;
  if (right.order !== undefined) return 1;
  return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
}

function publishingNode(document: NativeStoryDocument) {
  const order = nodeOrder(document.metadata);
  return { id: document.id, title: nodeTitle(document.metadata, document.id), ...(order === undefined ? {} : { order }) };
}

function readPublishingHierarchy(reader: SnapshotReader) {
  const volumes: NativeStoryDocument[] = [];
  const chapters: NativeStoryDocument[] = [];
  const scenes = new Map<string, NativeStoryDocument>();
  for (const document of reader.nativeStoryDocuments ?? []) {
    if (document.kind === "volume") volumes.push(document);
    if (document.kind === "chapter") chapters.push(document);
    if (document.kind === "scene") {
      if (scenes.has(document.id)) throw new Error("Duplicate scene identity in publishing snapshot: " + document.id);
      scenes.set(document.id, document);
    }
  }
  return { volumes, chapters, scenes };
}

function isRootScene(document: NativeStoryDocument): boolean {
  return !Object.hasOwn(document.metadata, "volume") && !Object.hasOwn(document.metadata, "chapter");
}

function publishingScene(document: NativeStoryDocument) {
  const source = document.metadata.manuscript;
  const path = typeof source === "string" ? source : "";
  assertProjectPath(path);
  if (!path.toLowerCase().endsWith(".md")) throw new Error("Scene manuscript must be a Markdown file");
  return { ...publishingNode(document), path, body: "" };
}

/** Populate the selected scenes from the same immutable snapshot as their metadata. */
export async function loadPublishingSceneBodies(reader: SnapshotReader, scenes: readonly PublishingScene[]): Promise<void> {
  if (!scenes.length) return;
  if (!reader.readMany) throw new Error("Publishing manuscript batch reads are unavailable");
  for (let start = 0; start < scenes.length; start += SNAPSHOT_READ_MANY_LIMIT) {
    const batch = scenes.slice(start, start + SNAPSHOT_READ_MANY_LIMIT);
    const manuscripts = await reader.readMany(batch.map(scene => scene.path));
    if (manuscripts.length !== batch.length) throw new Error("Publishing manuscript batch did not match its requested paths");
    for (const [index, scene] of batch.entries()) {
      const manuscript = manuscripts[index];
      scene.body = manuscript ? splitManuscriptMarkdown(manuscript.content).body : "";
    }
  }
}

function coreTree(value: unknown): CoreTree {
  const data = record(value);
  const validNode = (node: unknown): node is { id: string; title: string } => {
    const item = record(node);
    return typeof item?.id === "string" && typeof item.title === "string";
  };
  if (!data || typeof data.title !== "string" || !Array.isArray(data.volumes)) {
    throw new Error("Core hierarchy response is invalid");
  }
  for (const volume of data.volumes) {
    const volumeData = record(volume);
    if (!validNode(volume) || !Array.isArray(volumeData?.chapters)) {
      throw new Error("Core hierarchy response is invalid");
    }
    for (const chapter of volumeData.chapters) {
      const chapterData = record(chapter);
      if (!validNode(chapter) || !Array.isArray(chapterData?.scenes) || !chapterData.scenes.every(validNode)) {
        throw new Error("Core hierarchy response is invalid");
      }
    }
  }
  return data as unknown as CoreTree;
}

function sameSnapshot(left: unknown, right: SnapshotId): boolean {
  const snapshot = record(left);
  return snapshot?.projectId === right.projectId && snapshot.projectVersion === right.projectVersion;
}

export async function readPublishingProjectFromCore(
  context: ModuleActionContext,
  { includeManuscripts = true, scope = "all", id }: { includeManuscripts?: boolean; scope?: PublishingScope; id?: string } = {},
): Promise<PublishingProject> {
  const { reader } = context;
  const coreResult = await context.invoke("core.tree", {}, context.signal);
  if (!coreResult.ok) throw new Error("Core hierarchy read failed: " + coreResult.error.message);
  if (!sameSnapshot(coreResult.snapshot, reader.snapshot)) {
    throw new Error("Core hierarchy belongs to another snapshot");
  }
  const coreData = record(coreResult.data);
  if (!coreData || !sameSnapshot(coreData.snapshot, reader.snapshot)) {
    throw new Error("Core hierarchy belongs to another snapshot");
  }
  const hierarchy = coreTree(coreData.tree);
  const subtitle = reader.projectPresentation?.subtitle;
  const { volumes: volumeDocuments, chapters: chapterDocuments, scenes: sceneDocuments } = readPublishingHierarchy(reader);
  const volumeMetadata = new Map(volumeDocuments.map((document) => [document.id, publishingNode(document)]));
  const chapterMetadata = new Map(chapterDocuments.map((document) => [document.id, publishingNode(document)]));
  const sceneMetadata = new Map([...sceneDocuments.values()].map(document => [document.id, publishingScene(document)]));

  const seenSceneIds = new Set<string>();
  const volumes: PublishingVolume[] = hierarchy.volumes.map((volume) => ({
    ...volumeMetadata.get(volume.id),
    id: volume.id,
    title: volume.title,
    chapters: volume.chapters.map((chapter) => ({
      ...chapterMetadata.get(chapter.id),
      id: chapter.id,
      title: chapter.title,
      scenes: chapter.scenes.map((scene) => {
        if (seenSceneIds.has(scene.id)) throw new Error("Duplicate scene identity in Core hierarchy: " + scene.id);
        seenSceneIds.add(scene.id);
        const metadata = sceneMetadata.get(scene.id);
        if (!metadata) throw new Error("Scene metadata is missing from the publishing snapshot: " + scene.id);
        return { ...metadata, title: scene.title, volumeId: volume.id, chapterId: chapter.id };
      }),
    })),
  }));
  const rootScenes: PublishingScene[] = [];
  for (const document of sceneDocuments.values()) {
    if (seenSceneIds.has(document.id) || !isRootScene(document)) continue;
    rootScenes.push({ ...sceneMetadata.get(document.id)!, volumeId: "", chapterId: "" });
  }
  const project = { title: hierarchy.title, ...(subtitle ? { subtitle } : {}), volumes, rootScenes: rootScenes.sort(compareOrdered) };
  if (includeManuscripts) await loadPublishingSceneBodies(reader, collectPublishingScenes(project, scope, id));
  return project;
}

/** Read a public snapshot projection without composing actions or crossing its authorization boundary. */
export async function readPublishingProject(reader: SnapshotReader, { includeManuscripts = true } = {}): Promise<PublishingProject> {
  const { title = "Project", subtitle } = reader.projectPresentation ?? {};
  const { volumes: volumeDocuments, chapters: chapterDocuments, scenes: sceneDocuments } = readPublishingHierarchy(reader);
  const volumes: PublishingVolume[] = volumeDocuments.map((document) => ({ ...publishingNode(document), chapters: [] }));
  const volumesById = new Map(volumes.map((volume) => [volume.id, volume]));
  const chaptersById = new Map<string, { chapter: PublishingChapter; volumeId: string }>();
  for (const document of chapterDocuments) {
    const volumeId = document.metadata.volume;
    const parent = typeof volumeId === "string" ? volumesById.get(volumeId) : undefined;
    if (!parent) continue;
    const chapter: PublishingChapter = { ...publishingNode(document), scenes: [] };
    parent.chapters.push(chapter);
    chaptersById.set(chapter.id, { chapter, volumeId: parent.id });
  }

  const rootScenes: PublishingScene[] = [];
  for (const document of sceneDocuments.values()) {
    if (isRootScene(document)) {
      rootScenes.push({ ...publishingScene(document), volumeId: "", chapterId: "" });
      continue;
    }
    const chapterId = document.metadata.chapter;
    const parent = typeof chapterId === "string" ? chaptersById.get(chapterId) : undefined;
    if (!parent) continue;
    parent.chapter.scenes.push({ ...publishingScene(document), volumeId: parent.volumeId, chapterId: parent.chapter.id });
  }
  for (const volume of volumes) {
    volume.chapters.sort(compareOrdered);
    for (const chapter of volume.chapters) chapter.scenes.sort(compareOrdered);
  }
  const project = { title, ...(subtitle ? { subtitle } : {}), volumes: volumes.sort(compareOrdered), rootScenes: rootScenes.sort(compareOrdered) };
  if (includeManuscripts) await loadPublishingSceneBodies(reader, collectPublishingScenes(project, "all"));
  return project;
}

export function collectPublishingScenes(
  project: PublishingProject,
  scope: PublishingScope,
  id?: string,
): PublishingScene[] {
  if (scope === "all") return [
    ...(project.rootScenes ?? []),
    ...project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes)),
  ];
  if (!id?.trim()) throw new Error("A volume or chapter ID is required for this export scope");
  const pickedId = id.trim();
  if (scope === "volume") {
    const volume = project.volumes.find((item) => item.id === pickedId);
    if (!volume) throw new Error("Volume not found: " + pickedId);
    return volume.chapters.flatMap((chapter) => chapter.scenes);
  }
  if (scope === "chapter") {
    for (const volume of project.volumes) {
      const chapter = volume.chapters.find((item) => item.id === pickedId);
      if (chapter) return chapter.scenes;
    }
    throw new Error("Chapter not found: " + pickedId);
  }
  throw new Error("Invalid export scope");
}

export function resolveShareScope(project: PublishingProject, scope: ShareScope): PublishingScene[] {
  if (!scope.id.trim()) throw new Error("A share scope ID is required");
  if (scope.kind === "volume") {
    const volume = project.volumes.find((item) => item.id === scope.id);
    if (!volume) throw new Error("Volume not found: " + scope.id);
    return volume.chapters.flatMap((chapter) => chapter.scenes);
  }
  if (scope.kind === "chapter") {
    for (const volume of project.volumes) {
      const chapter = volume.chapters.find((item) => item.id === scope.id);
      if (chapter) return chapter.scenes;
    }
    throw new Error("Chapter not found: " + scope.id);
  }
  if (scope.kind === "scene") {
    const scene = [...(project.rootScenes ?? []), ...project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes))]
      .find((item) => item.id === scope.id);
    if (!scene) throw new Error("Scene not found: " + scope.id);
    return [scene];
  }
  if (scope.kind === "project") return [
    ...(project.rootScenes ?? []),
    ...project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes)),
  ];
  throw new Error("Invalid share scope");
}
