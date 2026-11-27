import type { ReactNode, RefObject } from 'react';

export type UiMode = 'desktop';

/** A host-approved panel definition. The workspace stores its ID, never its renderer. */
export interface WorkspacePanel {
  id: string;
  title: string;
  /** Reparent this stable portal container into the panel's active slot. */
  preserveContainer?: HTMLElement;
  preserveParkingRef?: RefObject<HTMLDivElement | null>;
  render(): ReactNode;
}

export interface WorkspacePanelRequest {
  id: string;
  sequence: number;
  /** Choose the focus target after the requested panel is revealed. */
  getFocusTarget?: (panel: HTMLElement) => HTMLElement | undefined;
}

/** Production Desktop UI assembled by the application controller. */
export interface ApplicationShellProps {
  header: ReactNode;
  documentTitle?: string;
  documentContext?: string;
  status: ReactNode;
  /** Stable author and device scope for the Desktop layout. */
  workspaceScope: string;
  /** Host-approved core and activated module panels available in this workspace. */
  panels: readonly WorkspacePanel[];
  /** Flush and validate the active editor before a panel switch can unmount it. */
  beforeLayoutChange?: () => Promise<boolean>;
  /** Ask the workspace to reveal and focus a panel, for example History. */
  requestedPanel?: WorkspacePanelRequest;
}
