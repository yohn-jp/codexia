const list = document.getElementById('diagram-list');
const loading = document.getElementById('loading');
const loadingMessage = document.getElementById('loading-message');
const loadingActions = document.getElementById('loading-actions');
const retryLoad = document.getElementById('retry-load');
const retryDiagram = document.getElementById('retry-diagram');
const canvas = document.getElementById('canvas');
const nativeRenderer = document.createElement('div');
nativeRenderer.className = 'native-renderer';
nativeRenderer.hidden = true;
canvas.prepend(nativeRenderer);
const image = document.createElement('img');
image.id = 'svg-image';
image.alt = '';
image.hidden = true;
canvas.prepend(image);
const canvasDescription = document.getElementById('canvas-description');
const viewer = document.querySelector('.viewer');
const title = document.getElementById('diagram-title');
const groupTitle = document.getElementById('diagram-group');
const kind = document.getElementById('diagram-kind');
const sourceLink = document.getElementById('source-link');
const designLink = document.getElementById('design-link');
const svgLink = document.getElementById('svg-link');
const nativeInteract = document.getElementById('native-interact');
const viewStatus = document.getElementById('view-status');
const zoomIn = document.getElementById('zoom-in');
const zoomOut = document.getElementById('zoom-out');
const zoomReset = document.getElementById('zoom-reset');
const fitDiagram = document.getElementById('fit-diagram');
const zoomValue = document.getElementById('zoom-value');
const query = document.getElementById('diagram-query');
const category = document.getElementById('diagram-category');
const resultCount = document.getElementById('result-count');
const catalogCount = document.getElementById('catalog-count');
const catalogResults = document.getElementById('catalog-results');
const emptyResults = document.getElementById('empty-results');
const clearSearch = document.getElementById('clear-search');
const clearEmptySearch = document.getElementById('clear-empty-search');
const screenContract = document.getElementById('screen-contract');
const evidence = document.getElementById('implementation-evidence');
const evidenceSummary = document.getElementById('evidence-summary-status');
const graphState = document.getElementById('graph-state');
const diagramTotal = document.getElementById('diagram-total');
const sourceShaElement = document.getElementById('source-sha');

let diagrams = [];
let current = null;
let zoom = 1;
let graphIndex = null;
let graphIndexStatus = 'pending';
let zoomMode = 'width';
let imageAttempt = 0;
let sourceSha = '';
const buttons = new Map();
const groups = new Map();
const narrowViewport = window.matchMedia('(max-width: 900px)');
let wasNarrow = narrowViewport.matches;

function setZoom(next, preservePosition = true, fixedWidthPx = null) {
  const oldMaxX = Math.max(1, canvas.scrollWidth - canvas.clientWidth);
  const oldMaxY = Math.max(1, canvas.scrollHeight - canvas.clientHeight);
  const horizontalPosition = oldMaxX > 1 ? canvas.scrollLeft / oldMaxX : 0;
  const verticalPosition = oldMaxY > 1 ? canvas.scrollTop / oldMaxY : 0;
  zoom = Math.min(4, Math.max(.1, next));
  image.style.width = fixedWidthPx === null
    ? Number((zoom * 100).toFixed(2)) + '%'
    : Math.floor(fixedWidthPx) + 'px';
  zoomValue.textContent = Math.round(zoom * 100) + '%';
  zoomOut.disabled = !image.naturalWidth || zoom <= .1;
  zoomIn.disabled = !image.naturalWidth || zoom >= 4;
  zoomReset.disabled = !image.naturalWidth || Math.abs(zoom - 1) < .01;
  fitDiagram.disabled = !image.naturalWidth;
  if (!preservePosition) {
    canvas.scrollTop = 0;
    canvas.scrollLeft = 0;
    return;
  }
  // Apply the preserved position in the same input turn as the zoom change.
  // A deferred animation frame can overwrite a scroll made immediately afterward.
  canvas.scrollLeft = horizontalPosition * Math.max(0, canvas.scrollWidth - canvas.clientWidth);
  canvas.scrollTop = verticalPosition * Math.max(0, canvas.scrollHeight - canvas.clientHeight);
}

function fitWholeDiagram() {
  if (!image.naturalWidth || !image.naturalHeight) return;
  const style = getComputedStyle(canvas);
  const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const widthAtFit = Math.max(1, canvas.clientWidth - paddingX);
  const heightAtFit = Math.max(1, canvas.clientHeight - paddingY);
  const renderedWidth = Math.min(
    widthAtFit,
    heightAtFit * image.naturalWidth / image.naturalHeight,
    image.naturalWidth,
  );
  const scale = renderedWidth / widthAtFit;
  setZoom(scale, false, Math.floor(renderedWidth));
  viewStatus.textContent = '図全体を表示 · ' + zoomValue.textContent;
}

zoomIn.addEventListener('click', () => {
  zoomMode = 'manual';
  setZoom(zoom + .25);
  viewStatus.textContent = '表示倍率 ' + zoomValue.textContent;
});
zoomOut.addEventListener('click', () => {
  zoomMode = 'manual';
  setZoom(zoom - .25);
  viewStatus.textContent = '表示倍率 ' + zoomValue.textContent;
});
zoomReset.addEventListener('click', () => {
  zoomMode = 'width';
  setZoom(1, false);
  viewStatus.textContent = '幅に合わせて表示 · 100%';
});
fitDiagram.addEventListener('click', () => {
  zoomMode = 'all';
  fitWholeDiagram();
});

function sourceUrl(path, line) {
  return 'https://github.com/yohn-jp/codexia/blob/' + sourceSha + '/' +
    path.split('/').map(encodeURIComponent).join('/') + (line ? '#L' + line : '');
}

function addText(parent, tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function updateEvidenceSummary(diagram) {
  const ids = diagram?.screenIds ?? [];
  const paths = Array.isArray(diagram?.implementationPaths) ? diagram.implementationPaths : [];
  const parts = [];
  parts.push(ids.length ? ids.join(' · ') : '画面IDなし');
  parts.push(paths.length ? paths.length + ' source path' : '関連パスなし');
  if (graphIndexStatus === 'ready' && graphIndex) {
    parts.push(graphIndex.sourceSha === sourceSha ? 'SHA一致' : 'SHA不一致');
  } else if (graphIndexStatus === 'unavailable') {
    parts.push('Graphify索引未取得');
  }
  evidenceSummary.textContent = parts.join(' · ');
}

function graphEvidence(diagram) {
  evidence.replaceChildren();
  const paths = Array.isArray(diagram.implementationPaths) ? diagram.implementationPaths : [];
  if (!paths.length) {
    addText(evidence, 'p', 'この図には実装ファイルを結び付ける設計メタデータがありません。実装状態は未確認です。');
    return;
  }
  if (graphIndexStatus === 'pending') {
    addText(evidence, 'p', '同じ版のGraphify静的索引を確認しています。');
    return;
  }
  if (graphIndexStatus === 'unavailable' || !graphIndex) {
    addText(evidence, 'p', 'Graphify静的索引を利用できないため、関連ファイルは未確認です。');
    return;
  }
  if (graphIndex.sourceSha !== sourceSha) {
    addText(evidence, 'p', 'AtlasとGraphifyのSHAが異なるため、別の版のソースリンクは表示しません。');
    return;
  }
  const indexed = new Set(graphIndex.files.map(file => file.path));
  const matches = paths.filter(path => indexed.has(path));
  if (!matches.length) {
    addText(evidence, 'p', '同じSHAのGraphify索引に対象ファイルがありません。実装根拠は未確認です。');
    return;
  }
  addText(evidence, 'p', '同じSHAのGraphify静的索引にある関連ソースです。設計の実装受入を証明するものではありません。');
  const links = document.createElement('ul');
  for (const path of matches) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = '../graph/?file=' + encodeURIComponent(path);
    link.textContent = path;
    link.setAttribute('aria-label', 'Code Mapで関連ソース ' + path + ' を開く');
    const code = document.createElement('code');
    code.textContent = path;
    link.replaceChildren(code);
    item.append(link);
    links.append(item);
  }
  evidence.append(links);
}

function renderContract(diagram) {
  screenContract.replaceChildren();
  const ids = diagram.screenIds ?? [];
  if (!ids.length) {
    addText(screenContract, 'p', 'この図は画面IDを直接識別していません。個別画面との対応は未確認です。');
    return;
  }
  const status = diagram.designStatus || '状態未記載';
  addText(screenContract, 'p', '設計状態: ' + status + '。実装状態は別途確認が必要です。');
  const contracts = diagram.screenContracts ?? [];
  const contractById = new Map(contracts.map(contract => [contract.id, contract]));
  const items = document.createElement('ul');
  for (const id of ids) {
    const item = document.createElement('li');
    const contract = contractById.get(id);
    if (contract) {
      const link = document.createElement('a');
      link.href = sourceUrl(contract.path, contract.line);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const code = document.createElement('code');
      code.textContent = id;
      link.append(code);
      item.append(link);
      const statusText = document.createElement('span');
      statusText.className = 'screen-contract-status';
      statusText.textContent = ' · ' + contract.status;
      item.append(statusText);
    } else {
      const code = document.createElement('code');
      code.className = 'screen-id';
      code.textContent = id;
      item.append(code);
      item.append(document.createTextNode(' · 操作台帳の該当行は未取得です。'));
    }
    items.append(item);
  }
  screenContract.append(items);
}

function show(diagram, options = {}) {
  if (!diagram || !diagrams.includes(diagram)) return;
  const updateHash = options.updateHash !== false;
  const fromUser = options.fromUser === true;
  const reveal = options.reveal === true;
  current = diagram;
  title.textContent = diagram.title;
  canvasDescription.textContent = '図全体は上下左右にスクロールして確認できます。';
  groupTitle.textContent = diagram.groupLabel;
  kind.textContent = diagram.kind;
  sourceLink.href = sourceUrl(diagram.sourcePath, diagram.line);
  designLink.href = '../requirements/html/' + diagram.designPath +
    '.html#' + encodeURIComponent(diagram.designUid);
  const isNative = diagram.renderer === 'likec4';
  nativeInteract.hidden = !isNative;
  nativeInteract.disabled = isNative;
  svgLink.hidden = isNative;
  svgLink.href = isNative ? '#' : diagram.image;
  document.querySelector('.zoom-controls').hidden = isNative;
  image.hidden = true;
  nativeRenderer.hidden = true;
  nativeRenderer.replaceChildren();
  loading.hidden = false;
  loadingMessage.textContent = isNative ? 'LikeC4ビューを読み込んでいます。' : 'SVGを読み込んでいます。';
  loadingActions.hidden = true;
  retryLoad.hidden = true;
  retryDiagram.hidden = true;
  zoomOut.disabled = true;
  zoomIn.disabled = true;
  zoomReset.disabled = true;
  fitDiagram.disabled = true;
  if (isNative) {
    void loadNativeView(diagram);
  } else {
    loadSvgView(diagram, options);
  }
  canvas.scrollTop = 0;
  canvas.scrollLeft = 0;
  zoom = 1;
  zoomMode = 'width';
  zoomValue.textContent = '100%';
  for (const [id, button] of buttons) {
    button.hidden = !matches(id);
    if (id === diagram.id) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  for (const [id, group] of groups) {
    group.hidden = ![...group.querySelectorAll('button')].some(button => !button.hidden);
  }
  renderContract(diagram);
  graphEvidence(diagram);
  updateEvidenceSummary(diagram);
  if (updateHash && location.hash !== '#' + diagram.id) history.replaceState(null, '', '#' + diagram.id);
  if ((fromUser || reveal) && narrowViewport.matches) {
    catalogResults.open = false;
    if (fromUser) title.focus({ preventScroll: true });
    requestAnimationFrame(() => viewer.scrollIntoView({ block: 'start' }));
  }
}

function openNativeExplorer() {
  const component = nativeRenderer.querySelector('likec4-view');
  const pane = component?.shadowRoot && findInOpenShadowTree(component.shadowRoot, '.react-flow__pane');
  if (!pane) {
    viewStatus.textContent = 'LikeC4ビューの準備ができていません。再読み込みしてください。';
    return;
  }
  pane.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, view: window }));
  viewStatus.textContent = '図を操作中 · Escキーでビューに戻れます';
}
nativeInteract.addEventListener('click', openNativeExplorer);

function findInOpenShadowTree(root, selector) {
  const match = root.querySelector(selector);
  if (match) return match;
  for (const element of root.querySelectorAll('*')) {
    if (!element.shadowRoot) continue;
    const nested = findInOpenShadowTree(element.shadowRoot, selector);
    if (nested) return nested;
  }
  return null;
}

async function loadNativeView(diagram) {
  try {
    await import('./' + diagram.artifact);
    if (current?.id !== diagram.id) return;
    await customElements.whenDefined('likec4-view');
    if (current?.id !== diagram.id) return;
    const component = document.createElement('likec4-view');
    component.setAttribute('view-id', diagram.viewId);
    component.setAttribute('browser', 'true');
    component.setAttribute('color-scheme', 'dark');
    component.setAttribute('aria-label', diagram.groupLabel + ' — ' + diagram.title);
    nativeRenderer.append(component);
    nativeRenderer.hidden = false;
    nativeInteract.disabled = false;
    loading.hidden = true;
    viewStatus.textContent = 'LikeC4を表示中 · 図の操作はビュー内で行えます';
  } catch {
    if (current?.id !== diagram.id) return;
    nativeRenderer.hidden = true;
    loading.hidden = false;
    loadingMessage.textContent = 'LikeC4ビューを読み込めませんでした。正本の設計書を開くか、再読み込みしてください。';
    loadingActions.hidden = false;
    nativeInteract.disabled = true;
    retryDiagram.hidden = false;
    viewStatus.textContent = 'LikeC4の表示に失敗';
  }
}

function loadSvgView(diagram, options) {
  image.alt = diagram.groupLabel + ' — ' + diagram.title + ' の設計図。全内容はリンク先の設計正本で確認できます。';
  image.onload = () => {
    if (current?.id !== diagram.id) return;
    image.hidden = false;
    loading.hidden = true;
    zoomMode = 'width';
    setZoom(1, false);
    viewStatus.textContent = '図を表示中 · 幅に合わせて表示 · 100%';
  };
  image.onerror = () => {
    if (current?.id !== diagram.id) return;
    image.hidden = true;
    loading.hidden = false;
    loadingMessage.textContent = 'SVGを読み込めませんでした。設計正本を開くか、図を再読み込みしてください。';
    loadingActions.hidden = false;
    retryDiagram.hidden = false;
    viewStatus.textContent = 'SVGの表示に失敗';
  };
  image.src = options.retry
    ? diagram.image + '?retry=' + Date.now() + '-' + (++imageAttempt)
    : diagram.image;
}

function matches(id) {
  const diagram = diagrams.find(item => item.id === id);
  if (!diagram) return false;
  const term = query.value.trim().toLocaleLowerCase();
  const groupOk = category.value === 'all' || category.value === diagram.group;
  const haystack = [
    diagram.id, diagram.title, diagram.groupLabel, diagram.kind, diagram.designPath, diagram.sourcePath,
    ...(diagram.screenIds ?? []),
    ...(diagram.screenContracts ?? []).flatMap(contract => [contract.id, contract.status]),
    ...(diagram.implementationPaths ?? []),
  ].join(' ').toLocaleLowerCase();
  return groupOk && (!term || haystack.includes(term));
}

function filterList() {
  let count = 0;
  for (const [id, button] of buttons) {
    button.hidden = !matches(id);
    if (!button.hidden) count++;
  }
  for (const group of groups.values()) {
    group.hidden = ![...group.querySelectorAll('button')].some(button => !button.hidden);
  }
  emptyResults.hidden = count !== 0;
  catalogCount.textContent = count + ' / ' + diagrams.length;
  resultCount.textContent = count
    ? count + ' / ' + diagrams.length + '件の図'
    : '一致する図はありません。条件を変更してください。';
  if (current && !matches(current.id) && count) {
    resultCount.textContent += ' · 選択中の図は表示中です。候補を選ぶと切り替わります。';
  }
  if (narrowViewport.matches && (query.value.trim() || category.value !== 'all')) catalogResults.open = true;
}

function clearFilters() {
  query.value = '';
  category.value = 'all';
  catalogResults.open = true;
  filterList();
  query.focus();
}
query.addEventListener('input', filterList);
category.addEventListener('change', filterList);
clearSearch.addEventListener('click', clearFilters);
clearEmptySearch.addEventListener('click', clearFilters);

function addButtons() {
  for (const diagram of diagrams) {
    let group = groups.get(diagram.group);
    if (!group) {
      const section = document.createElement('section');
      section.className = 'group';
      section.dataset.group = diagram.group;
      addText(section, 'h3', diagram.groupLabel);
      const items = document.createElement('ul');
      items.setAttribute('role', 'list');
      section.append(items);
      list.append(section);
      groups.set(diagram.group, section);
      group = section;
    }
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.diagramId = diagram.id;
    button.textContent = diagram.title;
    const detail = document.createElement('small');
    detail.textContent = diagram.id + ' · ' + diagram.kind;
    button.append(detail);
    button.addEventListener('click', () => show(diagram, { fromUser: true }));
    buttons.set(diagram.id, button);
    item.append(button);
    group.querySelector('ul').append(item);
  }
  for (const [id, group] of groups) {
    const first = diagrams.find(item => item.group === id);
    const option = document.createElement('option');
    option.value = id;
    option.textContent = first.groupLabel;
    category.append(option);
  }
}

function updateGraphStatus() {
  graphState.replaceChildren();
  if (graphIndexStatus === 'pending') {
    graphState.dataset.state = 'pending';
    graphState.textContent = 'Graphify静的索引を確認しています。';
    return;
  }
  if (graphIndexStatus === 'unavailable' || !graphIndex) {
    graphState.dataset.state = 'unavailable';
    graphState.textContent = 'Graphify静的索引を利用できません。関連ソースは未確認です。';
    return;
  }
  graphState.dataset.state = graphIndex.sourceSha === sourceSha ? 'match' : 'mismatch';
  const status = document.createElement('span');
  status.textContent = graphIndex.sourceSha === sourceSha
    ? 'Graphify静的索引 · Atlasと同じSHA'
    : 'Graphify静的索引 · Atlasとは別のSHA';
  graphState.append(status, document.createTextNode(' '));
  const hash = document.createElement('code');
  hash.textContent = graphIndex.sourceSha;
  graphState.append(hash);
  graphState.append(document.createTextNode(graphIndex.sourceSha === sourceSha
    ? '。ソース探索用で、実装受入の証拠ではありません。'
    : '。異なる版のため、関連ソースへのリンクは表示しません。'));
}

async function loadGraphIndex() {
  try {
    const response = await fetch('../graph/source.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('graph HTTP ' + response.status);
    const data = await response.json();
    if (!/^[a-f0-9]{40}$/.test(data.sourceSha) || !Array.isArray(data.files) ||
        !data.files.every(file => file && typeof file.path === 'string')) throw new Error('invalid graph index');
    graphIndex = data;
    graphIndexStatus = 'ready';
  } catch {
    graphIndex = null;
    graphIndexStatus = 'unavailable';
  }
  updateGraphStatus();
  if (current) {
    graphEvidence(current);
    updateEvidenceSummary(current);
  }
}

function setLoadFailure(message) {
  loading.hidden = false;
  image.hidden = true;
  loadingMessage.textContent = message;
  loadingActions.hidden = false;
  retryLoad.hidden = false;
  retryDiagram.hidden = true;
  sourceShaElement.textContent = '未取得';
  diagramTotal.textContent = '—';
  title.textContent = '図の一覧を読み込めません';
  canvasDescription.textContent = '図を読み込めないため、図の表示操作は利用できません。';
  groupTitle.textContent = '';
  kind.textContent = '';
  sourceLink.removeAttribute('href');
  designLink.removeAttribute('href');
  svgLink.removeAttribute('href');
  viewStatus.textContent = '一覧を表示できません';
  resultCount.textContent = '図の一覧を読み込めませんでした。';
  catalogCount.textContent = '—';
  zoomOut.disabled = true;
  zoomIn.disabled = true;
  zoomReset.disabled = true;
  fitDiagram.disabled = true;
}

async function load() {
  loading.hidden = false;
  loadingMessage.textContent = '図の一覧を読み込んでいます。';
  loadingActions.hidden = true;
  retryLoad.hidden = true;
  try {
    const response = await fetch('./manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('manifest HTTP ' + response.status);
    const manifest = await response.json();
    if (manifest.format !== 'codexia-architecture-atlas/v1' ||
        !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
        !Array.isArray(manifest.diagrams) || manifest.diagrams.length === 0 ||
        !manifest.diagrams.every(item => /^[a-z]+-\d+$/.test(item.id) &&
          (item.renderer === 'mermaid'
            ? item.image === 'svg/' + item.id + '.svg' &&
              item.sourcePath === 'docs/architecture/diagrams/' + item.id + '.mmd'
            : item.renderer === 'likec4' && /^likec4\/[a-z0-9-]+\.mjs$/.test(item.artifact) &&
              /^[a-z][a-z0-9-]*$/.test(item.viewId) &&
              item.sourceModel === 'docs/architecture/likec4/model.likec4' && item.sourcePath === item.sourceModel &&
              /^[a-f0-9]{64}$/.test(item.sourceModelSha256)) &&
          /^docs\/(?:architecture|design|deployment)\/[A-Z0-9-]+\.sdoc$/.test(item.designPath) &&
          item.designUid === 'ATLAS-DIAGRAM-' + item.id &&
          Number.isSafeInteger(item.line) && item.line > 0 &&
          typeof item.title === 'string' && typeof item.groupLabel === 'string' &&
          (!item.screenIds || (Array.isArray(item.screenIds) && item.screenIds.every(id => typeof id === 'string'))) &&
          (!item.screenContracts || (Array.isArray(item.screenContracts) && item.screenContracts.every(contract =>
            contract && typeof contract.id === 'string' && contract.path === 'docs/design/screen-catalog.json' &&
            Number.isSafeInteger(contract.line) &&
            contract.line > 0 && typeof contract.status === 'string'))) &&
          (!item.implementationPaths || (Array.isArray(item.implementationPaths) &&
            item.implementationPaths.every(path => typeof path === 'string'))))) {
      throw new Error('Invalid architecture manifest');
    }
    diagrams = manifest.diagrams;
    sourceSha = manifest.sourceSha;
    sourceShaElement.textContent = sourceSha;
    diagramTotal.textContent = diagrams.length + '件';
    addButtons();
    filterList();
    catalogResults.open = !narrowViewport.matches;
    navigateFromHash();
    window.addEventListener('hashchange', navigateFromHash);
    void loadGraphIndex();
  } catch {
    setLoadFailure('図の一覧を取得できませんでした。再試行するか、GitHubの設計書を確認してください。');
  }
}

function navigateFromHash() {
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); }
  catch { id = ''; }
  const diagram = diagrams.find(item => item.id === id);
  if (diagram) {
    query.value = '';
    category.value = 'all';
    catalogResults.open = !narrowViewport.matches;
    filterList();
    show(diagram, { updateHash: false, reveal: true });
  } else if (!current && diagrams.length) {
    show(diagrams[0], { updateHash: false });
  }
}

function updateResponsiveLayout() {
  const isNarrow = narrowViewport.matches;
  if (isNarrow !== wasNarrow) {
    catalogResults.open = !isNarrow;
    wasNarrow = isNarrow;
  }
  if (image.naturalWidth && !image.hidden && zoomMode === 'all') fitWholeDiagram();
}
narrowViewport.addEventListener('change', updateResponsiveLayout);
window.addEventListener('resize', updateResponsiveLayout, { passive: true });
retryLoad.addEventListener('click', () => void load());
retryDiagram.addEventListener('click', () => {
  if (current) show(current, { updateHash: false, retry: true });
});

void load();
