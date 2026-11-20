import { assertProjectPath, type ModuleActionContext, type SnapshotId, type SnapshotReader } from "@codexia/contracts";
import YAML from "yaml";

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

function nodeId(data: Record<string, unknown>, fallback: string): string {
  return typeof data.id === "string" && data.id.trim() ? data.id : fallback;
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

async function readYaml(reader: SnapshotReader, path: string): Promise<Record<string, unknown> | null> {
  const file = await reader.read(path);
  if (!file) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(file.content);
  } catch {
    throw new Error("Invalid YAML in " + path);
  }
  const result = record(parsed);
  if (!result) throw new Error("Expected a YAML mapping in " + path);
  return file.documentKind ? { ...result, kind: file.documentKind } : result;
}

function manuscriptBody(document: string, filePath: string): string {
  const opening = /^---[ \t]*\r?\n/.exec(document);
  if (!opening) return document;
  const delimiter = /^---[ \t]*\r?$/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(document);
  if (!closing) throw new Error("Unclosed Markdown frontmatter in " + filePath);
  const frontmatter = document.slice(opening[0].length, closing.index);
  try {
    const parsed = YAML.parse(frontmatter);
    if (parsed !== null && !record(parsed)) throw new Error("Frontmatter must be a mapping");
  } catch {
    throw new Error("Invalid Markdown frontmatter in " + filePath);
  }
  let start = closing.index + closing[0].length;
  if (document.startsWith("\r\n", start)) start += 2;
  else if (document.startsWith("\n", start)) start += 1;
  return document.slice(start);
}

function manuscriptPath(sceneFile: string, data: Record<string, unknown>, sceneId: string): string {
  const match = /^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/scenes\/[^/]+\.yaml$/.exec(sceneFile);
  const path = typeof data.manuscript === "string"
    ? data.manuscript
    : match ? "manuscript/" + match[1] + "/" + match[2] + "/" + sceneId + ".md" : "";
  assertProjectPath(path);
  if (!path.toLowerCase().endsWith(".md")) throw new Error("Scene manuscript must be a Markdown file");
  return path;
}

function folderIds(files: string[], prefix: string): string[] {
  return [...new Set(files.flatMap((path) => {
    if (!path.startsWith(prefix)) return [];
    const id = path.slice(prefix.length).split("/")[0];
    return id ? [id] : [];
  }))];
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

export async function readPublishingProjectFromCore(context: ModuleActionContext): Promise<PublishingProject> {
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
  const projectMetadata = await readYaml(reader, "meta/project.yaml");
  const subtitle = typeof projectMetadata?.subtitle === "string" && projectMetadata.subtitle.trim()
    ? projectMetadata.subtitle.trim()
    : undefined;
  const files = await reader.list("plot/volumes");
  const volumeOrders = new Map<string, PublishingOrder>();
  const chapterOrders = new Map<string, PublishingOrder>();
  for (const volumeId of folderIds(files, "plot/volumes/")) {
    const volumePath = "plot/volumes/" + volumeId + "/volume.yaml";
    const volumeData = await readYaml(reader, volumePath) ?? { id: volumeId };
    const volumeOrder = nodeOrder(volumeData);
    if (volumeOrder !== undefined) volumeOrders.set(nodeId(volumeData, volumeId), volumeOrder);
    const chapterPrefix = "plot/volumes/" + volumeId + "/chapters/";
    for (const chapterId of folderIds(files, chapterPrefix)) {
      const chapterBase = chapterPrefix + chapterId;
      const chapterData = await readYaml(reader, chapterBase + "/chapter.yaml") ?? { id: chapterId };
      const chapterOrder = nodeOrder(chapterData);
      if (chapterOrder !== undefined) chapterOrders.set(nodeId(chapterData, chapterId), chapterOrder);
    }
  }

  const sceneMetadata = new Map<string, { title: string; body: string; path: string; order?: PublishingOrder }>();
  for (const sceneFile of files.filter((path) => /\/scenes\/[^/]+\.yaml$/u.test(path))) {
    const sceneData = await readYaml(reader, sceneFile);
    if (!sceneData) continue;
    const basename = sceneFile.split("/").at(-1)!.slice(0, -".yaml".length);
    const id = nodeId(sceneData, basename);
    if (sceneMetadata.has(id)) throw new Error("Duplicate scene identity in publishing snapshot: " + id);
    const bodyPath = manuscriptPath(sceneFile, sceneData, id);
    const manuscript = await reader.read(bodyPath);
    const order = nodeOrder(sceneData);
    sceneMetadata.set(id, {
      title: nodeTitle(sceneData, id),
      body: manuscript ? manuscriptBody(manuscript.content, bodyPath) : "",
      path: bodyPath,
      ...(order === undefined ? {} : { order }),
    });
  }

  const seenSceneIds = new Set<string>();
  const volumes: PublishingVolume[] = hierarchy.volumes.map((volume) => ({
    id: volume.id,
    title: volume.title,
    ...(volumeOrders.has(volume.id) ? { order: volumeOrders.get(volume.id)! } : {}),
    chapters: volume.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      ...(chapterOrders.has(chapter.id) ? { order: chapterOrders.get(chapter.id)! } : {}),
      scenes: chapter.scenes.map((scene) => {
        if (seenSceneIds.has(scene.id)) throw new Error("Duplicate scene identity in Core hierarchy: " + scene.id);
        seenSceneIds.add(scene.id);
        const metadata = sceneMetadata.get(scene.id);
        if (!metadata) throw new Error("Scene metadata is missing from the publishing snapshot: " + scene.id);
        return {
          id: scene.id,
          title: scene.title,
          body: metadata.body,
          path: metadata.path,
          volumeId: volume.id,
          chapterId: chapter.id,
          ...(metadata.order === undefined ? {} : { order: metadata.order }),
        };
      }),
    })),
  }));
  return { title: hierarchy.title, ...(subtitle ? { subtitle } : {}), volumes };
}

/** Read a public snapshot projection without composing actions or crossing its authorization boundary. */
export async function readPublishingProject(reader: SnapshotReader): Promise<PublishingProject> {
  const projectMetadata = await readYaml(reader, "meta/project.yaml");
  const title = projectMetadata ? nodeTitle(projectMetadata, "Project") : "Project";
  const subtitle = typeof projectMetadata?.subtitle === "string" && projectMetadata.subtitle.trim()
    ? projectMetadata.subtitle.trim()
    : undefined;
  const files = await reader.list("plot/volumes");
  const volumesByPath = new Map<string, PublishingVolume>();
  const volumesById = new Map<string, PublishingVolume>();
  const chaptersById = new Map<string, PublishingChapter>();
  const chapterVolumeIds = new Map<PublishingChapter, string>();
  for (const volumeFile of files.filter((path) => /^plot\/volumes\/[^/]+\/volume\.yaml$/u.test(path))) {
    const volumePathId = volumeFile.split("/")[2]!;
    const volumeData = await readYaml(reader, volumeFile);
    if (!volumeData || volumeData.kind !== "volume") continue;
    const volumeId = nodeId(volumeData, volumePathId);
    const volumeOrder = nodeOrder(volumeData);
    const volume: PublishingVolume = {
      id: volumeId,
      title: nodeTitle(volumeData, volumeId),
      ...(volumeOrder === undefined ? {} : { order: volumeOrder }),
      chapters: [],
    };
    volumesByPath.set(volumePathId, volume);
    volumesById.set(volumeId, volume);
    const chapterPrefix = `plot/volumes/${volumePathId}/chapters/`;
    for (const chapterFile of files.filter((path) => path.startsWith(chapterPrefix) && /^plot\/volumes\/[^/]+\/chapters\/[^/]+\/chapter\.yaml$/u.test(path))) {
      const chapterPathId = chapterFile.split("/")[4]!;
      const chapterData = await readYaml(reader, chapterFile);
      if (!chapterData || chapterData.kind !== "chapter") continue;
      const chapterId = nodeId(chapterData, chapterPathId);
      const chapterOrder = nodeOrder(chapterData);
      const parentVolume = typeof chapterData.volume === "string" ? volumesById.get(chapterData.volume) : undefined;
      if (!parentVolume) continue;
      const chapter: PublishingChapter = {
        id: chapterId,
        title: nodeTitle(chapterData, chapterId),
        ...(chapterOrder === undefined ? {} : { order: chapterOrder }),
        scenes: [],
      };
      parentVolume.chapters.push(chapter);
      chaptersById.set(chapterId, chapter);
      chapterVolumeIds.set(chapter, parentVolume.id);
    }
  }

  for (const sceneFile of files.filter((path) => /^plot\/volumes\/[^/]+\/chapters\/[^/]+\/scenes\/[^/]+\.yaml$/u.test(path))) {
    const sceneData = await readYaml(reader, sceneFile);
    if (!sceneData || sceneData.kind !== "scene") continue;
    const match = /^plot\/volumes\/([^/]+)\/chapters\/([^/]+)\/scenes\/([^/]+)\.yaml$/u.exec(sceneFile);
    if (!match) continue;
    const basename = match[3]!;
    const id = nodeId(sceneData, basename);
    const chapter = typeof sceneData.chapter === "string" ? chaptersById.get(sceneData.chapter) : undefined;
    if (!chapter) continue;
    const bodyPath = manuscriptPath(sceneFile, sceneData, id);
    const manuscript = await reader.read(bodyPath);
    const order = nodeOrder(sceneData);
    chapter.scenes.push({
      id,
      title: nodeTitle(sceneData, id),
      body: manuscript ? manuscriptBody(manuscript.content, bodyPath) : "",
      path: bodyPath,
      volumeId: chapterVolumeIds.get(chapter) ?? "",
      chapterId: chapter.id,
      ...(order === undefined ? {} : { order }),
    });
  }

  for (const volume of volumesByPath.values()) {
    volume.chapters.sort(compareOrdered);
    for (const chapter of volume.chapters) chapter.scenes.sort(compareOrdered);
  }
  return { title, ...(subtitle ? { subtitle } : {}), volumes: [...volumesByPath.values()].sort(compareOrdered) };
}

export function collectPublishingScenes(
  project: PublishingProject,
  scope: PublishingScope,
  id?: string,
): PublishingScene[] {
  if (scope === "all") return project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes));
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
    const scene = project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes))
      .find((item) => item.id === scope.id);
    if (!scene) throw new Error("Scene not found: " + scope.id);
    return [scene];
  }
  if (scope.kind === "project") {
    return project.volumes.flatMap((volume) => volume.chapters.flatMap((chapter) => chapter.scenes));
  }
  throw new Error("Invalid share scope");
}
