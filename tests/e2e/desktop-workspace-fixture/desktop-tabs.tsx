import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Workspace } from "../../../app/src/workspace/Workspace";
import { createWorkspacePreset } from "../../../app/src/workspace/layout";
import { saveWorkspaceSnapshot } from "../../../app/src/workspace/persistence";
import type { WorkspacePanel } from "../../../app/src/application/contracts";

type GuardOutcome = boolean | "delayed";

interface DesktopTabsFixtureMetrics {
  guardCalls: number;
  outcomes: GuardOutcome[];
  release?: () => void;
  arm(outcomes: GuardOutcome[]): void;
  releaseGuard(): void;
  changeScope(scope: string): void;
}

declare global {
  interface Window {
    __desktopTabsFixture?: DesktopTabsFixtureMetrics;
  }
}

const panelIds = ["editor", "outline", "inspector"];
const workspacePanels: WorkspacePanel[] = [
  { id: "editor", title: "Editor", render: () => <div data-testid="fixture-editor">Editor fixture</div> },
  { id: "outline", title: "Outline", render: () => <div data-testid="fixture-outline">Outline fixture</div> },
  { id: "inspector", title: "Inspector", render: () => <div data-testid="fixture-inspector">Inspector fixture</div> },
];

function fixtureMetrics(): DesktopTabsFixtureMetrics {
  if (window.__desktopTabsFixture) return window.__desktopTabsFixture;
  const metrics: DesktopTabsFixtureMetrics = {
    guardCalls: 0,
    outcomes: [],
    arm(outcomes) {
      this.guardCalls = 0;
      this.outcomes = [...outcomes];
      this.release = undefined;
    },
    releaseGuard() {
      const release = this.release;
      this.release = undefined;
      release?.();
    },
    changeScope() {},
  };
  window.__desktopTabsFixture = metrics;
  return metrics;
}

function DesktopTabsFixture(): ReactNode {
  const [scope, setScope] = useState("desktop-tabs-fixture");
  const metrics = fixtureMetrics();

  if (scope === "desktop-tabs-fixture" && window.localStorage.getItem("scriptorium:workspace:v2:desktop-tabs-fixture:desktop") === null) {
    saveWorkspaceSnapshot(window.localStorage, scope, "desktop", {
      layout: createWorkspacePreset("research", panelIds),
      floating: [],
    });
  }

  useEffect(() => {
    metrics.changeScope = (nextScope) => setScope(nextScope);
    return () => { metrics.changeScope = () => {}; };
  }, [metrics]);

  const beforeLayoutChange = async (): Promise<boolean> => {
    const outcome = metrics.outcomes.shift();
    metrics.guardCalls += 1;
    if (outcome === "delayed") {
      return new Promise<boolean>((resolve) => { metrics.release = () => resolve(true); });
    }
    return outcome ?? true;
  };

  return <>
    <output data-testid="desktop-tabs-scope">{scope}</output>
    <Workspace scope={scope} mode="desktop" panels={workspacePanels} beforeLayoutChange={beforeLayoutChange} />
  </>;
}

export function renderDesktopTabsFixture(root: HTMLElement): void {
  // The fixture's workspace is mounted in this isolated browser context only.
  createRoot(root).render(<DesktopTabsFixture />);
}
