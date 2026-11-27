import { useEffect, useRef, useState } from 'react';
import type { ApplicationShellProps, WorkspacePanelRequest } from '../../application/contracts';
import { requestConsoleNavigation } from '../../console/console-navigation';
import { IdentityManagementPanel } from '../../settings/IdentityManagementPanel';
import { Workspace } from '../../workspace/Workspace';
import './desktop.css';
import '../editorial.css';
import './studio.css';
import '../authoring.css';
import './desktop-refinement.css';

/** Desktop manuscript surface; panels and commands remain owned by the shared workspace. */
export function DesktopShell({
  header,
  documentTitle,
  documentContext,
  status,
  workspaceScope,
  panels,
  beforeLayoutChange,
  requestedPanel,
}: ApplicationShellProps) {
  const requestSeq = useRef(0);
  const [effectiveRequest, setEffectiveRequest] = useState<WorkspacePanelRequest>();

  useEffect(() => {
    if (!requestedPanel?.id || !requestedPanel.sequence) return;
    setEffectiveRequest({ ...requestedPanel, sequence: ++requestSeq.current });
  }, [requestedPanel]);

  return (
    <div className="st-desktop-shell st-studio-shell">
      <div className="st-studio-main">
        <div className="st-studio-topbar">
          <div className="st-studio-identity">
            <a className="st-studio-wordmark" href="/">
              codexia<span>.</span>
            </a>
            <nav className="st-studio-breadcrumb" aria-label="現在の原稿">
              <span>{documentContext || '作品ライブラリ'}</span>
              {documentTitle ? (
                <>
                  <span aria-hidden="true">/</span>
                  <strong>{documentTitle}</strong>
                </>
              ) : null}
            </nav>
          </div>
          <div className="st-studio-masthead-actions">
            <button type="button" data-ux-control="PREF-01.A" className="st-studio-console-link" onClick={requestConsoleNavigation}>
              管理コンソール
            </button>
            <IdentityManagementPanel placement="desktop" />
            <div className="st-studio-header-slot">{header}</div>
          </div>
        </div>

        <Workspace
          scope={workspaceScope}
          mode="desktop"
          panels={panels}
          beforeLayoutChange={beforeLayoutChange}
          requestedPanel={effectiveRequest}
        />
        <section className="st-desktop-status" aria-label="保存と接続の状態">
          {status}
        </section>
      </div>
    </div>
  );
}
