import { useEffect, useMemo, type ReactNode } from "react";
import {
  dragAndDropFeature,
  hotkeysCoreFeature,
  keyboardDragAndDropFeature,
  renamingFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";

const ROOT_ID = "codexia:outline-root";

export interface OutlineTreeDocument {
  id: string;
  title: string;
  kind: string;
  children: OutlineTreeDocument[];
  misplaced?: boolean;
}

interface Props {
  items: OutlineTreeDocument[];
  selectedId: string;
  focusedId: string;
  onFocusedIdChange: (id: string) => void;
  collapsedIds: ReadonlySet<string>;
  onCollapsedIdsChange: (update: (previous: Set<string>) => Set<string>) => void;
  forceExpanded: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onZoom: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onMove: (id: string, parentId: string | null) => Promise<void>;
  kindLabel: (kind: string) => string;
}

/** A projection of PostgreSQL's document hierarchy. Headless Tree never owns the data. */
export function DocumentOutlineTree({
  items, selectedId, focusedId, onFocusedIdChange, collapsedIds, onCollapsedIdsChange,
  forceExpanded, busy, onSelect, onZoom, onRename, onMove, kindLabel,
}: Props) {
  const index = useMemo(() => {
    const byId = new Map<string, OutlineTreeDocument>();
    const folders: string[] = [];
    const visit = (nodes: OutlineTreeDocument[]) => {
      for (const node of nodes) {
        byId.set(node.id, node);
        if (node.children.length) folders.push(node.id);
        visit(node.children);
      }
    };
    visit(items);
    return { byId, folders, roots: items.map((item) => item.id) };
  }, [items]);
  const expandedItems = useMemo(() => index.folders.filter((id) => forceExpanded || !collapsedIds.has(id)), [index, forceExpanded, collapsedIds]);

  const tree = useTree<OutlineTreeDocument>({
    rootItemId: ROOT_ID,
    dataLoader: {
      getItem: (id) => index.byId.get(id) ?? { id, title: "", kind: "root", children: [] },
      getChildren: (id) => id === ROOT_ID
        ? index.roots
        : index.byId.get(id)?.children.map((node) => node.id) ?? [],
    },
    getItemName: (item) => item.getItemData().title,
    isItemFolder: (item) => item.getId() === ROOT_ID || item.getItemData().children.length > 0,
    state: {
      expandedItems,
      focusedItem: focusedId && index.byId.has(focusedId) ? focusedId
        : selectedId && index.byId.has(selectedId) ? selectedId : (index.roots[0] ?? null),
    },
    setFocusedItem: (next) => {
      const value = typeof next === "function" ? next(focusedId || null) : next;
      onFocusedIdChange(value ?? "");
    },
    setExpandedItems: (next) => {
      if (forceExpanded) return;
      onCollapsedIdsChange((previous) => {
        const current = index.folders.filter((id) => !previous.has(id));
        const updated = typeof next === "function" ? next(current) : next;
        const keepExpanded = new Set(updated);
        const result = new Set(previous);
        for (const id of index.folders) {
          if (keepExpanded.has(id)) result.delete(id);
          else result.add(id);
        }
        return result;
      });
    },
    onPrimaryAction: (item) => {
      if (item.getId() !== ROOT_ID) onSelect(item.getId());
    },
    onRename: (item, title) => {
      const normalized = title.trim();
      if (normalized && normalized !== item.getItemData().title && !busy) onRename(item.getId(), normalized);
    },
    canRename: (item) => !busy && item.getId() !== ROOT_ID,
    indent: 20,
    canReorder: false, // A sibling reorder needs a canonical atomic server operation.
    seperateDragHandle: true,
    canDrag: (dragged) => !busy && dragged.length === 1 && dragged[0]?.getId() !== ROOT_ID,
    canDrop: (dragged, target) => {
      // Only reparenting is safe through the current single-document metadata API.
      if (busy || dragged.length !== 1 || "childIndex" in target) return false;
      const source = dragged[0]!;
      const parentId = target.item.getId();
      return parentId !== source.getId() &&
        (parentId === ROOT_ID || index.byId.has(parentId)) &&
        !target.item.isDescendentOf(source.getId());
    },
    onDrop: async (dragged, target) => {
      if (dragged.length !== 1 || "childIndex" in target) return;
      const targetParentId = target.item.getId();
      await onMove(dragged[0]!.getId(), targetParentId === ROOT_ID ? null : targetParentId);
    },
    features: [
      syncDataLoaderFeature, hotkeysCoreFeature, renamingFeature,
      dragAndDropFeature, keyboardDragAndDropFeature,
    ],
  });

  // Reconcile the immutable PostgreSQL projection after a committed refresh.
  useEffect(() => { tree.rebuildTree(); }, [items, tree]);
  tree.getItems(); // Populate stable item metadata before requesting ARIA properties.

  const renderBranch = (nodeIds: string[]): ReactNode => nodeIds.map((id) => {
    const item = tree.getItemInstance(id);
    const node = index.byId.get(id);
    if (!node) return null;
    const hasChildren = node.children.length > 0;
    const expanded = item.isExpanded();
    return <li key={id} role="none" className="pg-outline-item"
      data-kind={node.kind} data-document-id={id} data-drop-target={item.isUnorderedDragTarget() ? "true" : undefined}>
      <div className="pg-outline-row">
        {hasChildren ? <button type="button" className="pg-outline-toggle" tabIndex={-1}
          aria-label={expanded ? `${node.title}を折りたたむ` : `${node.title}を展開`}
          aria-expanded={expanded}
          onClick={(event) => { event.stopPropagation(); if (expanded) item.collapse(); else item.expand(); }}>
          {expanded ? "⌄" : "›"}
        </button> : <span className="pg-outline-spacer" aria-hidden="true" />}
        {item.isRenaming()
          ? <input {...item.getRenameInputProps()} className="pg-outline-rename" aria-label={`${node.title}の名前を変更`} maxLength={256} />
          : <button {...item.getProps()} type="button"
              className={`pg-outline-document${id === selectedId ? " is-selected" : ""}`}
              aria-current={id === selectedId ? "page" : undefined}
              aria-selected={id === selectedId}
              aria-label={`${node.title} ${node.misplaced ? `未配置 · ${kindLabel(node.kind)}` : kindLabel(node.kind)}`}
              onFocus={() => item.setFocused()}
              onKeyDownCapture={(event) => {
                // WAI-ARIA tree: ArrowRight on a leaf is a no-op. Headless Tree's
                // default shortcut advances to the next item; Codexia's existing
                // editor-outline contract must not unexpectedly move focus.
                if (!hasChildren && event.key === "ArrowRight") {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              onClick={() => { item.setFocused(); item.primaryAction(); }}>
              <span>{node.title}</span>
              <small>{node.misplaced ? `未配置 · ${kindLabel(node.kind)}` : kindLabel(node.kind)}</small>
            </button>}
        {hasChildren && <button type="button" tabIndex={id === focusedId ? 0 : -1} className="pg-outline-zoom"
          aria-label={`${node.title}を拡大`} onClick={() => onZoom(id)}>拡大</button>}
        <button {...item.getDragHandleProps()} type="button" className="pg-outline-drag"
          tabIndex={id === focusedId ? 0 : -1} aria-label={`${node.title}を移動`} disabled={busy}>⋮⋮</button>
      </div>
      {hasChildren && expanded &&
        <ul role="group" className="pg-document-children">{renderBranch(node.children.map((child) => child.id))}</ul>}
    </li>;
  });

  return <ul {...tree.getContainerProps("作品の構成")} className="pg-document-list">
    {renderBranch(index.roots)}
  </ul>;
}
