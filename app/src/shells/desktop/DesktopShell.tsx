import { useEffect, useRef, useState } from "react";
import * as Separator from "@radix-ui/react-separator";
import * as Tabs from "@radix-ui/react-tabs";
import { Panel, PanelGroup, PanelResizeHandle, setNonce } from "react-resizable-panels";
import type { ApplicationShellProps, WorkspacePanelRequest } from "../../application/contracts";
import { Workspace } from "../../workspace/Workspace";
import "./desktop.css";
import "../editorial.css";
import "./studio.css";
import "../authoring.css";

const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="codexia-style-nonce"]')?.content;
if (styleNonce) setNonce(styleNonce);

function describeFailure(reason: unknown): string {
  return reason instanceof Error && reason.message.trim()
    ? reason.message
    : "下書きの保存状態を確認してから、もう一度お試しください。";
}

/** Desktop manuscript surface; panels and commands remain owned by the shared workspace. */
export function DesktopShell({
  header, desktopActions, desktopDurability, desktopDurabilityDetail, documentTitle, documentContext, library, editor, tools, status, renderStatus,
  onSwitchMode, workspaceScope, panels, beforeLayoutChange, requestedPanel,
}: ApplicationShellProps) {
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const switchInFlight = useRef(false);
  const requestSeq = useRef(0);
  const [effectiveRequest, setEffectiveRequest] = useState<WorkspacePanelRequest>();

  useEffect(() => {
    if (!requestedPanel?.id || !requestedPanel.sequence) return;
    setEffectiveRequest({ id: requestedPanel.id, sequence: ++requestSeq.current });
  }, [requestedPanel?.id, requestedPanel?.sequence]);

  async function switchToMobile(): Promise<void> {
    if (switchInFlight.current) return;
    switchInFlight.current = true;
    setSwitching(true);
    setSwitchError("");
    try {
      const switched = await onSwitchMode();
      if (!switched) setSwitchError("モバイル画面へ切り替えられませんでした。保存状態を確認してから再試行してください。");
    } catch (reason) {
      setSwitchError("モバイル画面へ切り替えられませんでした。" + describeFailure(reason));
    } finally {
      switchInFlight.current = false;
      setSwitching(false);
    }
  }
  return (
    <div className="st-desktop-shell st-studio-shell">
      <div className="st-studio-main">
        <div className="st-studio-topbar">
          <div className="st-studio-identity">
            <a className="st-studio-wordmark" href="/">codexia<span>.</span></a>
            <div className="st-studio-breadcrumb" aria-label="現在の原稿">
              <span>{documentContext || "作品ライブラリ"}</span>
              {documentTitle ? <><span aria-hidden="true">/</span><strong>{documentTitle}</strong></> : null}
            </div>
          </div>
          <div className="st-studio-masthead-actions">
            {desktopDurability ? <span className={`st-studio-durability is-${desktopDurability}`}
              aria-label="原稿のPostgreSQL保存状態" data-state={desktopDurability} title={desktopDurabilityDetail}>
              {{
                draft: "PostgreSQL未保存",
                saving: "PostgreSQLへ保存中",
                uncertain: "保存状態を要確認",
                saved: "PostgreSQL保存済み",
              }[desktopDurability]}</span> : null}
            {desktopActions}
            <div className="st-studio-header-slot">{header}</div>
            <button type="button" className="st-studio-mobile-link" onClick={() => void switchToMobile()} disabled={switching}>
              {switching ? "切替中" : "モバイル ↗"}
            </button>
          </div>
        </div>

        {workspaceScope && panels?.length ? (
          <Workspace scope={workspaceScope} mode="desktop" panels={panels}
            beforeLayoutChange={beforeLayoutChange} requestedPanel={effectiveRequest} />
        ) : <PanelGroup className="st-desktop-workbench" direction="horizontal" id="codexia-desktop-workbench">
          <Panel className="st-desktop-navigation-panel" defaultSize={28} minSize={18} maxSize={46}
            id="codexia-desktop-navigation" order={1}>
            <Tabs.Root className="st-desktop-navigation" defaultValue="library" orientation="horizontal">
              <Tabs.List className="st-desktop-panel-tabs" aria-label="ナビゲーションとツール">
                <Tabs.Trigger className="st-desktop-panel-tab" value="library">作品ライブラリ</Tabs.Trigger>
                <Tabs.Trigger className="st-desktop-panel-tab" value="tools">ツールと履歴</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content className="st-desktop-tab-content" value="library" forceMount>
                <section className="st-desktop-slot st-desktop-library-slot" aria-label="作品ライブラリ">{library}</section>
              </Tabs.Content>
              <Tabs.Content className="st-desktop-tab-content" value="tools">
                <section className="st-desktop-slot st-desktop-tools-slot" aria-label="ツールと履歴">{tools}</section>
              </Tabs.Content>
            </Tabs.Root>
          </Panel>
          <PanelResizeHandle className="st-desktop-resize-handle" aria-label="作品パネルと原稿パネルの幅を変更"
            aria-describedby="st-desktop-resize-help">
            <Separator.Root className="st-desktop-resize-line" decorative orientation="vertical" />
          </PanelResizeHandle>
          <Panel className="st-desktop-editor-panel" defaultSize={72} minSize={42}
            id="codexia-desktop-editor" order={2}>
            <main className="st-desktop-editor-slot" aria-label="原稿の編集と読書" tabIndex={-1}>{editor}</main>
          </Panel>
        </PanelGroup>}
        <span className="st-desktop-visually-hidden" id="st-desktop-resize-help">
          左右矢印キーでパネル幅を変更できます。
        </span>
        <div className="st-desktop-status" role="region" aria-label="保存と接続の状態">
          {renderStatus ? renderStatus(switchError) : status}
        </div>
      </div>
    </div>
  );
}
