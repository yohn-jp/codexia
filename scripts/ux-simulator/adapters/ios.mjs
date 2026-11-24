const appRoot = 'ios/CodexiaApp/Sources';
const editorRoot = 'ios/CodexiaEditor/Sources';
const appPath = appRoot + '/CodexiaApp.swift';
const authoringPath = editorRoot + '/CodexiaEditor/AuthoringView.swift';
const statePath = editorRoot + '/CodexiaEditor/EditorState.swift';
const editorPath = editorRoot + '/CodexiaEditor/ManuscriptEditor.swift';

const screenIDs = new Map([
  ['library', 'LIB-01'], ['outline', 'OUT-01'], ['writing', 'WRT-01'], ['reading', 'READ-01'],
  ['history', 'WRT-02'], ['review', 'REV-01'], ['knowledge', 'KNO-01'], ['settings', 'PREF-01'],
  ['project', 'impl:ios.fixture-project'],
]);

function sourceText(source, path) { return source.read(path); }

function locate(source, path, symbol) {
  return source.location(path, symbol);
}

function matchingBrace(text, openIndex) {
  let depth = 0;
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockDepth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockDepth > 0) {
      if (char === '/' && next === '*') { blockDepth += 1; index += 1; }
      else if (char === '*' && next === '/') { blockDepth -= 1; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockDepth = 1; index += 1; continue; }
    if (char === '"') { quote = true; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return index;
  }
  return -1;
}

function viewStructs(text) {
  const structs = [];
  const pattern = /(?:(?:private|public|internal)\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*View\s*\{/g;
  for (const match of text.matchAll(pattern)) {
    const open = match.index + match[0].lastIndexOf('{');
    const close = matchingBrace(text, open);
    if (close >= 0) structs.push({ name: match[1], body: text.slice(open, close + 1), full: match[0] + text.slice(open + 1, close), start: match.index });
  }
  return structs;
}

function enumCases(text) {
  return [...text.matchAll(/^\s*case\s+([^\n]+)/gm)]
    .flatMap((match) => match[1].split(',').map((value) => value.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1]).filter(Boolean));
}

function roleForContainer(name) {
  return ({ NavigationStack: 'navigation', List: 'list', VStack: 'content', HStack: 'actions', ScrollView: 'scroll', Menu: 'menu', ToolbarItem: 'toolbar' })[name];
}

function regionsFor(body) {
  const seen = new Map();
  const regions = [];
  const container = /\b(NavigationStack|List|VStack|HStack|ScrollView|Menu|ToolbarItem)\b/g;
  for (const match of body.matchAll(container)) {
    const role = roleForContainer(match[1]);
    const count = (seen.get(role) ?? 0) + 1;
    seen.set(role, count);
    regions.push({ id: role + '-' + count, role });
  }
  if (/\.sheet\s*\(/.test(body)) regions.push({ id: 'sheet', role: 'sheet' });
  if (/\.alert\s*\(/.test(body)) regions.push({ id: 'alert', role: 'alert' });
  return regions;
}

function viewScreen(source, path, struct, titleNeedle) {
  const idLiteral = struct.body.match(/\.accessibilityIdentifier\("screen\.([A-Za-z0-9_.-]+)"\)/)?.[0];
  if (!idLiteral) return null;
  const short = idLiteral.match(/screen\.([A-Za-z0-9_.-]+)/)?.[1];
  const id = screenIDs.get(short);
  if (!id) return null;
  const title = struct.body.match(/\.navigationTitle\("([^"]+)"\)/)?.[1];
  const sourceRef = locate(source, path, idLiteral);
  return { id, platform: 'ios', source: sourceRef, ...(struct.name === 'FixtureProjectView' ? { form: 'navigation' } : {}),
    ...(title ? { route: title } : {}), regions: regionsFor(struct.body) };
}

function logicalScreen(short) { return screenIDs.get(short) ?? null; }

function parseScreenIdLiteral(literal) {
  const short = literal.match(/screen\.([A-Za-z0-9_.-]+)/)?.[1];
  return short ? logicalScreen(short) : null;
}

function controlLabel(text, index) {
  const start = Math.max(0, index - 280);
  const prefix = text.slice(start, index);
  const calls = [...prefix.matchAll(/\b(Button|NavigationLink|Menu)\s*\(\s*"([^"\n]*)"/g)];
  const call = calls.at(-1);
  return call ? { role: call[1].toLowerCase(), label: call[2] } : {};
}

function extractControls(source, files, structsByFile) {
  const controls = [];
  const seen = new Set();
  for (const path of files) {
    const text = sourceText(source, path);
    const patterns = [
      /\.accessibilityIdentifier\("(CTRL-[A-Z]+-\d{2}\.[A-Z])(?:\.[^"]*)?"\)/g,
      /return\s+"(CTRL-[A-Z]+-\d{2}\.[A-Z])"/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const id = match[1].replace(/^CTRL-/, '');
        if (seen.has(id)) continue;
        seen.add(id);
        const owner = (structsByFile.get(path) ?? []).find(({ start, body }) => match.index >= start && match.index < start + body.length);
        const screenLiteral = owner?.body.match(/\.accessibilityIdentifier\("screen\.(library|project|outline|writing)"\)/)?.[0];
        const screenId = screenLiteral ? parseScreenIdLiteral(screenLiteral)
          : path === authoringPath ? 'WRT-01' : null;
        controls.push({ id, platform: 'ios', source: locate(source, path, match[0]),
          ...(screenId ? { region: screenId } : {}), ...controlLabel(text, match.index) });
      }
    }
  }
  return controls.sort((left, right) => left.id.localeCompare(right.id));
}

function addTransition(transitions, source, path, id, from, to, event, symbol, extras = {}) {
  const sourceRef = locate(source, path, symbol);
  if (!sourceRef) return;
  transitions.push({ id, platform: 'ios', from, to, event, ...extras, source: sourceRef, method: 'static' });
}

function liveEditorRoute(app) {
  const buttonNeedle = 'Button("\\(count.formatted()) 文字のサンプル") {';
  const buttonIndex = app.indexOf(buttonNeedle);
  if (buttonIndex < 0) return false;
  const bodyOpen = app.indexOf('{', buttonIndex + buttonNeedle.length - 1);
  const bodyClose = matchingBrace(app, bodyOpen);
  if (bodyClose < 0) return false;
  const buttonBody = app.slice(bodyOpen, bodyClose + 1);
  return buttonBody.includes('editor = FixtureEditingSession(characterCount: count)')
    && app.includes('.navigationDestination(isPresented: Binding(')
    && app.includes('FixtureEditorDestination(session: session) {')
    && app.includes('if editor === session { editor = nil }')
    && app.includes('if !$0, editor?.state.canLeave == true { editor = nil }');
}

function extractTransitions(source, app, authoring, state, editor, controlIds) {
  const transitions = [];
  const launch = 'WindowGroup { LibraryView() }';
  addTransition(transitions, source, appPath, 'ios.app.launch-library', 'ios.app.launch', 'LIB-01', 'launch', launch, { screen: 'LIB-01' });

  const structs = viewStructs(app);
  const ownerScreen = new Map(structs.map(({ name, body }) => {
    const literal = body.match(/\.accessibilityIdentifier\("screen\.(library|project|outline|writing)"\)/)?.[0];
    return [name, literal ? parseScreenIdLiteral(literal) : null];
  }));
  for (const { name, body } of structs) {
    const from = ownerScreen.get(name);
    if (!from) continue;
    const links = /NavigationLink\("([^"\n]+)"\)\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\}/g;
    for (const match of body.matchAll(links)) {
      const destination = match[2];
      const to = destination === 'FixtureProjectView' ? 'impl:ios.fixture-project' : ownerScreen.get(destination);
      if (!to) continue;
      const marker = body.slice(match.index + match[0].length, match.index + match[0].length + 100).match(/\.accessibilityIdentifier\("(CTRL-[A-Z]+-\d{2}\.[A-Z])"\)/)?.[1];
      const id = 'ios.nav.' + name.replace(/View$/, '').toLowerCase() + '.' + destination.replace(/View$/, '').toLowerCase();
      addTransition(transitions, source, appPath, id, from, to, 'open:' + match[1], match[0],
        { ...(marker ? { control: marker.slice(5) } : {}), screen: from });
    }
  }

  const editorAssignment = 'editor = FixtureEditingSession(characterCount: count)';
  if (liveEditorRoute(app)) {
    const guardNeedle = 'if !$0, editor?.state.canLeave == true { editor = nil }';
    addTransition(transitions, source, appPath, 'ios.nav.outline.open-editor', 'OUT-01', 'WRT-01', 'openEditor', editorAssignment,
      { control: controlIds.has('OUT-01.B') ? 'OUT-01.B' : undefined, condition: 'editor != nil → FixtureEditorDestination(session: session)', screen: 'OUT-01' });
    addTransition(transitions, source, appPath, 'ios.nav.editor.back-to-outline', 'WRT-01', 'OUT-01', 'back', guardNeedle,
      { condition: 'editor?.state.canLeave == true', screen: 'WRT-01' });
  }

  const sheetNeedle = '.sheet(item: $reference) { screen in';
  const sheetContent = '.accessibilityIdentifier("screen.\\(screen.rawValue)")';
  const referenceCases = authoring.match(/private enum ReferenceScreen:[\s\S]*?\n\}/)?.[0] ?? '';
  const cases = enumCases(referenceCases);
  const referenceTarget = { reading: 'READ-01', history: 'impl:WRT-02', review: 'impl:REV-01', knowledge: 'impl:KNO-01', settings: 'impl:PREF-01' };
  if (authoring.includes(sheetNeedle) && authoring.includes(sheetContent)) {
    for (const name of cases) {
      const to = referenceTarget[name];
      if (!to) continue;
      const control = name === 'reading' && controlIds.has('WRT-01.B') ? 'WRT-01.B' : undefined;
      addTransition(transitions, source, authoringPath, 'ios.sheet.open.' + name, 'WRT-01', to, 'selectReference:' + name, sheetNeedle,
        { ...(control ? { control } : {}), screen: 'WRT-01' });
      const dismiss = 'Button("閉じる") { reference = nil }';
      addTransition(transitions, source, authoringPath, 'ios.sheet.dismiss.' + name, to, 'WRT-01', 'dismissReference', dismiss, { screen: to });
    }
  }

  const backAction = 'if state.canLeave { onLeave() } else { showingProtectionNotice = true }';
  addTransition(transitions, source, authoringPath, 'ios.guard.back-to-outline', 'WRT-01', 'OUT-01', 'back', backAction,
    { condition: 'state.canLeave', screen: 'WRT-01' });
  addTransition(transitions, source, authoringPath, 'ios.guard.back-blocked', 'WRT-01', 'ios.protection-notice', 'backBlocked', backAction,
    { condition: '!state.canLeave', screen: 'WRT-01' });

  for (const match of state.matchAll(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const signature = match[0];
    addTransition(transitions, source, statePath, 'ios.state.EditorState.' + match[1], 'EditorState', 'EditorState', match[1], signature);
  }
  for (const match of editor.matchAll(/\bpublic\s+func\s+(textViewDid[A-Za-z]+)\s*\(/g)) {
    const signature = match[0];
    addTransition(transitions, source, editorPath, 'ios.editor.callback.' + match[1], 'ManuscriptEditor', 'EditorState', match[1], signature);
  }
  return transitions;
}

function explicitPlaceholders(source, authoring, enumCases) {
  const marker = 'Text("この画面はまだ接続されていません。原稿には変更を加えません。")';
  if (!authoring.includes(marker)) return [];
  const ref = locate(source, authoringPath, marker);
  const map = { history: 'WRT-02', review: 'REV-01', knowledge: 'KNO-01', settings: 'PREF-01' };
  return enumCases.filter((name) => name !== 'reading' && map[name]).map((name) => ({
    id: map[name], platform: 'ios', status: 'unimplemented',
    reason: 'The native sheet explicitly renders the not-connected placeholder.', source: ref,
  }));
}

/** Derive only source-backed iOS structure. This adapter does not run or emulate Swift behavior. */
export function project(source) {
  const iosFiles = source.list('ios').filter((path) => path.endsWith('.swift')).sort();
  const appFiles = iosFiles.filter((path) => path.startsWith(appRoot + '/'));
  const editorFiles = iosFiles.filter((path) => path.startsWith(editorRoot + '/'));
  const allFiles = [...appFiles, ...editorFiles];
  const textByPath = new Map(allFiles.map((path) => [path, sourceText(source, path)]));
  const structsByFile = new Map(allFiles.map((path) => [path, viewStructs(textByPath.get(path))]));
  const screens = [];
  for (const path of allFiles) {
    for (const struct of structsByFile.get(path)) {
      const screen = viewScreen(source, path, struct);
      if (screen && !screens.some(({ id }) => id === screen.id)) screens.push(screen);
    }
  }

  const authoring = textByPath.get(authoringPath) ?? '';
  const enumText = authoring.match(/private enum ReferenceScreen:[\s\S]*?\n\}/)?.[0] ?? '';
  const enumNeedle = enumText.match(/private enum ReferenceScreen:[^\n]+/)?.[0];
  const cases = enumCases(enumText);
  const dynamicScreenMarker = '.accessibilityIdentifier("screen.\\(screen.rawValue)")';
  const dynamicSource = enumNeedle ? locate(source, authoringPath, enumNeedle) : locate(source, authoringPath, dynamicScreenMarker);
  const dynamicScreens = { reading: 'READ-01', history: 'impl:WRT-02', review: 'impl:REV-01', knowledge: 'impl:KNO-01', settings: 'impl:PREF-01' };
  for (const name of cases) {
    const id = dynamicScreens[name];
    if (!id || screens.some(({ id: existing }) => existing === id)) continue;
    screens.push({ id, platform: 'ios', source: dynamicSource, form: 'sheet', regions: [{ id: 'sheet-content', role: 'sheet' }] });
  }
  screens.sort((left, right) => left.id.localeCompare(right.id));

  const controls = extractControls(source, allFiles, structsByFile);
  const controlIds = new Set(controls.map(({ id }) => id));
  const transitions = extractTransitions(source, textByPath.get(appPath) ?? '', authoring,
    textByPath.get(statePath) ?? '', textByPath.get(editorPath) ?? '', controlIds);
  const gaps = explicitPlaceholders(source, authoring, cases);
  return { screens, controls, transitions: transitions.sort((left, right) => left.id.localeCompare(right.id)), gaps };
}
