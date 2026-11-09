import type { RecentActivityDeviceType } from "@codexia/contracts";
import type { Project } from "@codexia/persistence-contracts";
import type { Tree } from "../api";
import { formatHandoffHint, sceneTitleInTree, type ContinueCandidate } from "../resume/continueCandidates";
import type { JournalEntry } from "../storage/journal";

export function LibraryOutline({ projects, activeProjectId, tree, selectedSceneId, continueCandidates, deviceType, continueError, recoverableEntries, onActivateProject, onContinue, onSelectScene }: {
  projects: Project[]; activeProjectId: string | null; tree: Tree | null; selectedSceneId: string; continueCandidates: ContinueCandidate[]; deviceType: RecentActivityDeviceType; continueError: string; recoverableEntries: JournalEntry[];
  onActivateProject(project: Project): void; onContinue(candidate: ContinueCandidate, reading: boolean): void; onSelectScene(id: string): void;
}) {
  return <aside className="sidebar" aria-label="作品と構成"><h2>作品</h2><ul>{projects.map((project) => <li key={project.id}><button type="button" aria-current={activeProjectId === project.id} onClick={() => onActivateProject(project)}>{project.title}</button></li>)}</ul>{tree && <><TreeNav tree={tree} selectedSceneId={selectedSceneId} disabled={false} onSelect={onSelectScene} /><ContinuePanel candidates={continueCandidates} tree={tree} deviceType={deviceType} error={continueError} onContinue={(candidate) => onContinue(candidate, false)} onRead={(candidate) => onContinue(candidate, true)} /></>}<RecoveryList entries={recoverableEntries} /></aside>;
}

function ContinuePanel({
  candidates,
  tree,
  deviceType,
  error,
  onContinue,
  onRead,
}: {
  candidates: ContinueCandidate[];
  tree: Tree;
  deviceType: RecentActivityDeviceType;
  error: string;
  onContinue: (candidate: ContinueCandidate) => void;
  onRead: (candidate: ContinueCandidate) => void;
}) {
  return (
    <section className="continue-panel" aria-labelledby="continue-title">
      <h2 id="continue-title">続きから</h2>
      {error && <p className="continue-error" role="status">再開位置を同期できません: {error}</p>}
      {candidates.length === 0 ? <p className="muted-list-item">再開できるシーンがまだありません</p> : (
        <ul className="continue-list">
          {candidates.map((candidate, index) => {
            const handoff = candidate.source === "server"
              ? formatHandoffHint(candidate.deviceType, candidate.updatedAt, Date.now(), deviceType)
              : null;
            return (
              <li key={candidate.sceneId}>
                <strong>{sceneTitleInTree(tree, candidate.sceneId)}</strong>
                {handoff && <small>{handoff}</small>}
                <button type="button" className="quiet-button compact-button" onClick={() => onContinue(candidate)}>
                  {index === 0 ? "続きを書く" : "こちらを開く"}
                </button>
                {candidate.pageIndex !== null && (
                  <button type="button" className="quiet-button compact-button" onClick={() => onRead(candidate)}>
                    読書位置を開く
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TreeNav({ tree, selectedSceneId, disabled, onSelect }: { tree: Tree; selectedSceneId: string; disabled: boolean; onSelect: (id: string) => void }) {
  return (
    <nav className="tree" aria-label="作品構成">
      <h2>{tree.title}</h2>
      {tree.volumes.map((volume) => (
        <section className="tree-volume" key={volume.id}>
          <h3>{volume.title}</h3>
          {volume.chapters.map((chapter) => (
            <details key={chapter.id} open>
              <summary>{chapter.title}</summary>
              <ul className="scene-list">
                {chapter.scenes.map((scene) => (
                  <li key={scene.id}>
                    <button type="button" className="scene-button" aria-current={selectedSceneId === scene.id ? "true" : "false"} disabled={disabled} onClick={() => onSelect(scene.id)}>
                      {chapter.title}: {scene.title}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      ))}
    </nav>
  );
}

export function RecoveryList({ entries }: { entries: JournalEntry[] }) {
  return <ul className="recovery-list">{entries.map((entry) => <li key={entry.key}><strong>{entry.documentPath}</strong><span>{entry.state}</span><small>{entry.projectId} · Revision {entry.snapshot.projectVersion}</small><pre>{entry.text}</pre></li>)}</ul>;
}
