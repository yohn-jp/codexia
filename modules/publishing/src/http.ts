import type { HttpContribution, ModuleActionContext } from '@codexia/contracts';
import { constantTimeHashMatches, grantIsActive, hashShareToken, readShareGrants } from './grants.js';
import { loadPublishingSceneBodies, type PublishingScene, readPublishingProject, resolveShareScope } from './project.js';

const NOT_FOUND = { error: 'Share link is unavailable' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

function routeParts(request: Request): { token: string; sceneId?: string } | null {
  const match = new URL(request.url).pathname.match(/(?:^|\/)share\/([^/]+)(?:\/scenes\/([^/]+))?\/?$/);
  if (!match?.[1]) return null;
  let token: string;
  let sceneId: string | undefined;
  try {
    token = decodeURIComponent(match[1]);
    sceneId = match[2] ? decodeURIComponent(match[2]) : undefined;
  } catch {
    return null;
  }
  if (token.length > 128 || !/^share_[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  return { token, ...(sceneId ? { sceneId } : {}) };
}

function activeGrant(grants: Awaited<ReturnType<typeof readShareGrants>>['grants'], token: string) {
  const hash = hashShareToken(token);
  return grants.find(grant => constantTimeHashMatches(grant.tokenHash, hash) && grantIsActive(grant));
}

function publicScene(scene: PublishingScene) {
  return { id: scene.id, title: scene.title };
}

function safeTree(project: Awaited<ReturnType<typeof readPublishingProject>>, scenes: PublishingScene[]) {
  const allowed = new Set(scenes.map(scene => scene.id));
  return project.volumes.flatMap(volume => {
    const chapters = volume.chapters.flatMap(chapter => {
      const selected = chapter.scenes.filter(scene => allowed.has(scene.id));
      if (!selected.length) return [];
      return [
        {
          chapter: { id: chapter.id, title: chapter.title },
          scenes: selected.map(publicScene),
        },
      ];
    });
    if (!chapters.length) return [];
    return [{ volume: { id: volume.id, title: volume.title }, chapters }];
  });
}

async function readPublicShare(request: Request, context: ModuleActionContext): Promise<Response> {
  const parts = routeParts(request);
  if (!parts) return json(NOT_FOUND, 404);
  const { grants } = await readShareGrants(context);
  const grant = activeGrant(grants, parts.token);
  if (!grant) return json(NOT_FOUND, 404);
  const scope = { kind: grant.scope.kind, id: grant.scope.id };

  let project: Awaited<ReturnType<typeof readPublishingProject>>;
  let scopedScenes: PublishingScene[];
  try {
    project = await readPublishingProject(context.reader, { includeManuscripts: false });
    scopedScenes = resolveShareScope(project, scope);
  } catch {
    return json(NOT_FOUND, 404);
  }

  if (parts.sceneId) {
    const scene = scopedScenes.find(item => item.id === parts.sceneId);
    if (!scene) return json(NOT_FOUND, 404);
    try {
      await loadPublishingSceneBodies(context.reader, [scene]);
    } catch {
      return json(NOT_FOUND, 404);
    }
    return json({
      snapshot: { projectId: context.reader.snapshot.projectId, projectVersion: context.reader.snapshot.projectVersion },
      id: scene.id,
      title: scene.title,
      body: scene.body,
    });
  }

  const rootSceneIds = new Set((project.rootScenes ?? []).map(scene => scene.id));
  return json({
    snapshot: { projectId: context.reader.snapshot.projectId, projectVersion: context.reader.snapshot.projectVersion },
    label: grant.label,
    scope,
    expiresAt: grant.expiresAt,
    sceneCount: scopedScenes.length,
    rootScenes: scopedScenes.filter(scene => rootSceneIds.has(scene.id)).map(publicScene),
    tree: safeTree(project, scopedScenes),
  });
}

export function createPublishingHttpContributions(): HttpContribution[] {
  const handle = (request: Request, context: ModuleActionContext) => readPublicShare(request, context);
  return [
    { id: 'publishing.http.public-share', path: 'share/:token', methods: ['GET'], access: 'public', effect: 'read', handle },
    {
      id: 'publishing.http.public-share-scene',
      path: 'share/:token/scenes/:sceneId',
      methods: ['GET'],
      access: 'public',
      effect: 'read',
      handle,
    },
  ];
}
