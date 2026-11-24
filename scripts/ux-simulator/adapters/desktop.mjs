import { createHash } from 'node:crypto';

const SAVE = 'app/src/application/persistence-save-machine.ts';

// Stable logical IDs point to canonical React/XState declarations. This table
// contains source ownership only: labels, guards, targets, and behavior remain
// in the product and design authorities.
const screens = [
  ['ENTRY-01', 'app/src/entries/desktop.tsx', 'window.location.pathname'],
  ['LIB-01', 'app/src/entries/desktop.tsx', 'PersistenceEntry mode="desktop"'],
  ['OUT-01', 'app/src/persistence/DocumentOutlineTree.tsx', 'export function DocumentOutlineTree'],
  ['WRT-01', 'app/src/persistence/PersistenceWorkspace.tsx', 'PersistenceWorkspaceController'],
  ['READ-01', 'app/src/persistence/PersistenceWorkspace.tsx', 'data-ux-control="WRT-01.B"'],
  ['WRT-02', 'app/src/persistence/PersistenceWorkspace.tsx', 'data-ux-control="WRT-02.A"'],
  ['REC-01', SAVE, 'createPersistenceSaveMachine'],
  ['KNO-01', 'app/src/persistence/KnowledgeEvidenceList.tsx', 'export function KnowledgeEvidenceList'],
  ['KNO-02', 'app/src/persistence/KnowledgeEvidenceList.tsx', 'onOpenEvidence'],
  ['REV-01', 'app/src/persistence/NativeChangeSetReview.tsx', 'data-ux-control="REV-01.A"'],
  ['REV-02', 'app/src/persistence/NativeChangeSetReview.tsx', 'data-ux-control="REV-02.A"'],
  ['TOOL-01', 'app/src/application/AvailableModulePanels.tsx', 'export function availableModulePanels'],
  ['JOB-01', 'app/src/components/JobInbox.tsx', 'export function JobInbox'],
  ['DISPLAY-01', 'app/src/components/ThemeControl.tsx', 'export function ThemeControl'],
  ['PREF-01', 'app/src/shells/desktop/DesktopShell.tsx', 'requestConsoleNavigation'],
];

// IDs only. data-ux-control is placed on the actual canonical React controls;
// this inventory lets removal of an attribution remain visible as a gap.
const controlSources = new Map([
  ['ENTRY-01.A', ['app/src/entries/desktop.tsx', 'window.location.pathname']],
  ['LIB-01.A', ['app/src/persistence/PersistenceWorkspace.tsx', 'selectProject']],
  ['LIB-01.B', ['app/src/persistence/PersistenceWorkspace.tsx', 'createProject']],
  ['LIB-01.C', ['app/src/persistence/PersistenceWorkspace.tsx', 'importPortableWork']],
  ['LIB-01.D', ['app/src/persistence/PersistenceWorkspace.tsx', 'exportCurrentWork']],
  ['OUT-01.A', ['app/src/persistence/PersistenceWorkspace.tsx', 'setOutlineQuery']],
  ['OUT-01.B', ['app/src/persistence/DocumentOutlineTree.tsx', 'item.primaryAction']],
  ['OUT-01.C', ['app/src/persistence/PersistenceWorkspace.tsx', 'createDocument']],
  ['OUT-01.D', ['app/src/persistence/PersistenceWorkspace.tsx', 'editStructure']],
  ['OUT-01.E', ['app/src/persistence/PersistenceWorkspace.tsx', 'editStructure']],
  ['WRT-01.A', ['app/src/persistence/PersistenceWorkspace.tsx', 'saveDocument']],
  ['WRT-01.B', ['app/src/persistence/PersistenceWorkspace.tsx', 'protectTransition']],
  ['WRT-01.C', ['app/src/persistence/PersistenceWorkspace.tsx', 'createAnchor']],
  ['WRT-01.D', ['app/src/persistence/PersistenceWorkspace.tsx', 'storeTypographySettings']],
  ['WRT-02.A', ['app/src/persistence/PersistenceWorkspace.tsx', 'loadRevisions']],
  ['WRT-02.B', ['app/src/persistence/PersistenceWorkspace.tsx', 'restoreRevision']],
  ['REC-01.A', ['app/src/persistence/PersistenceWorkspace.tsx', 'retryDraftProtection']],
  ['REC-01.B', ['app/src/persistence/PersistenceWorkspace.tsx', 'saveDocument']],
  ['REC-01.C', ['app/src/persistence/PersistenceWorkspace.tsx', 'adoptRecoveredDraft']],
  ['KNO-01.A', ['app/src/persistence/PersistenceWorkspace.tsx', 'setKnowledgeQuery']],
  ['KNO-01.B', ['app/src/persistence/PersistenceWorkspace.tsx', 'createKnowledge']],
  ['KNO-02.A', ['app/src/persistence/KnowledgeEvidenceList.tsx', 'onOpenEvidence']],
  ['KNO-02.B', ['app/src/persistence/PersistenceWorkspace.tsx', 'linkKnowledge']],
  ['KNO-02.C', ['app/src/persistence/KnowledgeContextInspector.tsx', 'applyPersistenceMerge']],
  ['REV-01.A', ['app/src/persistence/NativeChangeSetReview.tsx', 'inspect']],
  ['REV-02.A', ['app/src/persistence/NativeChangeSetReview.tsx', 'updateAfterAction']],
  ['REV-02.B', ['app/src/contributions/ProposalReview.tsx', 'dismiss']],
  ['TOOL-01.A', ['app/src/application/AvailableModulePanels.tsx', 'WorkspaceContribution']],
  ['JOB-01.A', ['app/src/components/JobInbox.tsx', 'refresh']],
  ['DISPLAY-01.A', ['app/src/components/ThemeControl.tsx', 'onChange']],
  ['PREF-01.A', ['app/src/shells/desktop/DesktopShell.tsx', 'requestConsoleNavigation']],
]);

function gapSource(source, path, symbol) {
  const found = source.exists(path) ? source.location(path, symbol) : null;
  if (found) return found;
  if (source.exists(path)) return { path, line: 1 };
  return source.location('app/src/entries/desktop.tsx', 'window.location.pathname')
    ?? { path: 'app/src/entries/desktop.tsx', line: 1 };
}

function jsxEventExpression(tag) {
  const property = tag.match(/\bon(?:Click|Submit|Change|Select)\s*=\s*/);
  if (!property) return null;
  let cursor = property.index + property[0].length;
  if (tag[cursor] !== '{') return null;
  const close = balancedEnd(tag, cursor);
  return tag.slice(cursor + 1, close).trim();
}

function simpleLabel(text, tagEnd, tag, element) {
  const aria = tag.match(/\baria-label\s*=\s*["']([^"']+)["']/)?.[1];
  if (aria) return aria;
  if (element !== 'button') return undefined;
  const close = text.indexOf('</button>', tagEnd);
  if (close < 0) return undefined;
  const content = text.slice(tagEnd + 1, close).trim();
  return content && !/[<>{}]/.test(content) ? content : undefined;
}

function taggedControls(source) {
  const found = new Map();
  for (const path of source.list('app/src').filter((candidate) => /\.(tsx?|jsx?)$/.test(candidate)).sort()) {
    const text = source.read(path);
    for (const match of text.matchAll(/data-ux-control(?:-alias)?\s*=\s*\{?[^>]*?["']([A-Z]+-\d{2}\.[A-Z])["']/g)) {
      const id = match[1];
      if (!controlSources.has(id) || found.has(id)) continue;
      const at = match.index;
      const open = Math.max(...['<button', '<form', '<select', '<input'].map((tag) => text.lastIndexOf(tag, at)));
      if (open < 0) continue;
      let end = open;
      let braces = 0;
      for (; end < text.length; end += 1) {
        if (text[end] === '{') braces += 1;
        else if (text[end] === '}') braces -= 1;
        else if (text[end] === '>' && braces === 0) break;
      }
      const tag = text.slice(open, end + 1);
      const [, element] = tag.match(/^<(button|form|select|input)\b/) ?? [];
      const event = tag.match(/\bon(Click|Submit|Change|Select)\s*=/);
      const expectedHandler = controlSources.get(id)?.[1];
      if (!event || !expectedHandler) continue;
      const expression = jsxEventExpression(tag);
      if (!expression) continue;
      const calls = [...expression.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g)].map((call) => call[1]);
      const direct = expression.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)$/)?.[1];
      const linkedHandler = calls.find((call) => call === expectedHandler || call.endsWith(`.${expectedHandler}`));
      const handler = linkedHandler ?? (direct === expectedHandler ? direct : undefined)
        ?? calls.find((call) => !['preventDefault', 'stopPropagation', 'confirm', 'then', 'requestAnimationFrame', 'mutate'].includes(call.split('.').at(-1)));
      if (!handler) continue;
      const reference = source.location(path, id);
      if (!reference) continue;
      found.set(id, {
        id, platform: 'desktop', source: reference,
        label: simpleLabel(text, end, tag, element), role: element === 'form' ? 'form' : element === 'button' ? 'button' : 'control',
        handler,
      });
    }
  }
  return found;
}

function skipQuoted(text, index) {
  const quote = text[index];
  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\') cursor += 2;
    else if (text[cursor] === quote) return cursor + 1;
    else cursor += 1;
  }
  return cursor;
}

function balancedEnd(text, open, left = '{', right = '}') {
  let depth = 0;
  for (let cursor = open; cursor < text.length;) {
    const char = text[cursor];
    if (char === '"' || char === "'" || char === '`') cursor = skipQuoted(text, cursor);
    else if (char === '/' && text[cursor + 1] === '/') {
      cursor = text.indexOf('\n', cursor + 2);
      if (cursor < 0) return text.length;
    } else if (char === '/' && text[cursor + 1] === '*') {
      cursor = text.indexOf('*/', cursor + 2);
      if (cursor < 0) return text.length;
      cursor += 2;
    } else {
      if (char === left) depth += 1;
      else if (char === right && --depth === 0) return cursor;
      cursor += 1;
    }
  }
  return text.length;
}

function directProperties(text, open) {
  const close = balancedEnd(text, open);
  const properties = [];
  let cursor = open + 1;
  while (cursor < close) {
    while (cursor < close && /[\s,]/.test(text[cursor])) cursor += 1;
    if (cursor >= close) break;
    const keyStart = cursor;
    let key;
    if (text[cursor] === '"' || text[cursor] === "'") {
      const end = skipQuoted(text, cursor);
      key = text.slice(cursor + 1, end - 1);
      cursor = end;
    } else {
      const match = text.slice(cursor, close).match(/^([A-Za-z_$][\w$]*)/);
      if (!match) { cursor += 1; continue; }
      key = match[1];
      cursor += key.length;
    }
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    if (text[cursor] !== ':') { cursor += 1; continue; }
    cursor += 1;
    while (/\s/.test(text[cursor] ?? '')) cursor += 1;
    const valueStart = cursor;
    const valueType = text[cursor] === '{' || text[cursor] === '[' ? text[cursor] : null;
    properties.push({ key, keyStart, valueStart, valueType });
    if (valueType) cursor = balancedEnd(text, cursor, valueType, valueType === '{' ? '}' : ']') + 1;
    else cursor = expressionEnd(text, cursor, close);
  }
  return properties;
}

function expressionEnd(text, start, limit) {
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let cursor = start;
  while (cursor < limit) {
    const char = text[cursor];
    if (char === '"' || char === "'" || char === '`') cursor = skipQuoted(text, cursor);
    else if (char === '(') { parens += 1; cursor += 1; }
    else if (char === ')' && parens) { parens -= 1; cursor += 1; }
    else if (char === '{') { braces += 1; cursor += 1; }
    else if (char === '}' && braces) { braces -= 1; cursor += 1; }
    else if (char === '[') { brackets += 1; cursor += 1; }
    else if (char === ']' && brackets) { brackets -= 1; cursor += 1; }
    else if ((char === ',' || char === '}') && !parens && !braces && !brackets) return cursor;
    else cursor += 1;
  }
  return cursor;
}

function transitionDetails(text, open) {
  const props = directProperties(text, open);
  const target = props.find(({ key }) => key === 'target');
  if (!target) return null;
  const targetMatch = text.slice(target.valueStart).match(/^["']([^"']+)["']/);
  if (!targetMatch) return null;
  const guard = props.find(({ key }) => key === 'guard');
  let condition;
  if (guard) {
    const end = expressionEnd(text, guard.valueStart, balancedEnd(text, open));
    const expression = text.slice(guard.valueStart, end).trim();
    condition = expression.match(/^["']([^"']+)["']$/)?.[1] ?? (expression || 'unknown');
  }
  return { target: targetMatch[1], condition };
}

function transitionVariants(text, value) {
  if (value.valueType === '{') {
    const result = transitionDetails(text, value.valueStart);
    return result ? [result] : [];
  }
  if (value.valueType !== '[') return [];
  const close = balancedEnd(text, value.valueStart, '[', ']');
  const variants = [];
  for (let cursor = value.valueStart + 1; cursor < close;) {
    if (text[cursor] === '{') {
      const detail = transitionDetails(text, cursor);
      if (detail) variants.push(detail);
      cursor = balancedEnd(text, cursor) + 1;
    } else cursor += 1;
  }
  return variants;
}

function saveTransitions(source) {
  if (!source.exists(SAVE)) return [];
  const text = source.read(SAVE);
  const machineStart = text.indexOf('id: "persistenceSave"');
  if (machineStart < 0) return [];
  const statesOffset = text.indexOf('states: {', machineStart);
  if (statesOffset < 0) return [];
  const statesOpen = text.indexOf('{', statesOffset);
  const statesClose = balancedEnd(text, statesOpen);
  const transitions = [];
  const visitStates = (statesOpenAt, parentPath) => {
    for (const state of directProperties(text, statesOpenAt)) {
      if (state.valueType !== '{') continue;
      const statePath = parentPath ? `${parentPath}.${state.key}` : state.key;
      const stateProps = directProperties(text, state.valueStart);
      const on = stateProps.find(({ key, valueType }) => key === 'on' && valueType === '{');
      if (on) for (const event of directProperties(text, on.valueStart)) {
        const name = event.key;
        if (!/^[A-Z][A-Z_.]+$/.test(name)) continue;
        for (const variant of transitionVariants(text, event)) {
          const parent = statePath.split('.').slice(0, -1).join('.');
          const toPath = variant.target.startsWith('.') ? `${statePath}${variant.target}`
            : variant.target.startsWith('#') ? variant.target
              : [parent, variant.target].filter(Boolean).join('.');
          const line = text.slice(0, event.keyStart).split('\n').length;
          const conditionSuffix = variant.condition
            ? `/guard-${createHash('sha256').update(variant.condition).digest('hex').slice(0, 12)}` : '';
          transitions.push({
            id: `WRT-01/${statePath}/${name}/${toPath}${conditionSuffix}`, platform: 'desktop',
            from: `WRT-01/${statePath}`, to: `WRT-01/${toPath}`, event: name,
            ...(variant.condition ? { condition: variant.condition } : {}), screen: 'WRT-01',
            source: { path: SAVE, line, symbol: name }, method: 'static',
          });
        }
      }
      const nested = stateProps.find(({ key, valueType }) => key === 'states' && valueType === '{');
      if (nested) visitStates(nested.valueStart, statePath);
    }
  };
  visitStates(statesOpen, '');
  return transitions;
}

/** Derive the Desktop implementation projection from canonical source references. */
export function project(source) {
  const projectedScreens = [];
  const gaps = [];
  for (const [id, path, symbol] of screens) {
    const reference = source.exists(path) ? source.location(path, symbol) : null;
    if (reference) projectedScreens.push({ id, platform: 'desktop', source: reference });
    else gaps.push({ id, platform: 'desktop', status: 'unextracted', reason: 'Canonical Desktop screen source anchor is missing.', source: gapSource(source, path, symbol) });
  }

  const extracted = taggedControls(source);
  const controls = [];
  for (const [id, [path, symbol]] of controlSources) {
    const record = extracted.get(id);
    if (record) controls.push(record);
    else gaps.push({ id, platform: 'desktop', status: 'unextracted', reason: id === 'ENTRY-01.A'
      ? 'Desktop authoring starts from the canonical entry route; no separate interactive entry control is implemented.'
      : id === 'TOOL-01.A' ? 'Module controls are supplied through dynamic contribution components; no core-owned stable React control attribution was found.'
        : 'No canonical React element at this source reference carries the stable control ID; handler and label were left unextracted.',
    source: gapSource(source, path, symbol) });
  }

  const transitions = saveTransitions(source);
  return { screens: projectedScreens, controls, transitions, gaps };
}
