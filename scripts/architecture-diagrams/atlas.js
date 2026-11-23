const list = document.getElementById('diagram-list');
const image = document.getElementById('svg-image');
const loading = document.getElementById('loading');
const canvas = document.getElementById('canvas');
const title = document.getElementById('diagram-title');
const groupTitle = document.getElementById('diagram-group');
const kind = document.getElementById('diagram-kind');
const sourceLink = document.getElementById('source-link');
const svgLink = document.getElementById('svg-link');
const viewStatus = document.getElementById('view-status');
const zoomIn = document.getElementById('zoom-in');
const zoomOut = document.getElementById('zoom-out');
const zoomReset = document.getElementById('zoom-reset');
const query = document.getElementById('diagram-query');
const category = document.getElementById('diagram-category');
const resultCount = document.getElementById('result-count');
const screenContract = document.getElementById('screen-contract');
const evidence = document.getElementById('implementation-evidence');
const graphState = document.getElementById('graph-state');

let diagrams = [];
let current = null;
let zoom = 1;
let graphIndex = null;
const buttons = new Map();
const groupLabels = new Map();

function setZoom(next) {
  zoom = Math.min(3, Math.max(.5, next));
  image.style.width = Math.round(zoom * 100) + '%';
  zoomReset.textContent = Math.round(zoom * 100) + '%';
  zoomOut.disabled = zoom <= .5;
  zoomIn.disabled = zoom >= 3;
}
zoomIn.addEventListener('click', () => setZoom(zoom + .25));
zoomOut.addEventListener('click', () => setZoom(zoom - .25));
zoomReset.addEventListener('click', () => setZoom(1));

function graphEvidence(diagram) {
  evidence.replaceChildren();
  const paths = Array.isArray(diagram.implementationPaths) ? diagram.implementationPaths : [];
  if (!paths.length) {
    evidence.textContent = '対応する実装ファイルの明示的な設計メタデータはありません。実装状況は未確認です。';
    return;
  }
  if (!graphIndex) {
    evidence.textContent = 'Graph索引を利用できないため、実装ファイルは未確認です。';
    return;
  }
  if (graphIndex.sourceSha !== sourceSha) {
    evidence.textContent = 'AtlasとGraphのSHAが異なるため、実装ファイルへのリンクを表示しません。';
    return;
  }
  const indexed = new Set(graphIndex.files.map(file => file.path));
  const matches = paths.filter(path => indexed.has(path));
  if (!matches.length) {
    evidence.textContent = '同一SHAのGraph索引に対象ファイルがありません。実装根拠は未確認です。';
    return;
  }
  const intro = document.createElement('span');
  intro.textContent = '関連ソース（設計受入の証明ではありません。同一SHAでGraph索引済み）：';
  evidence.append(intro);
  for (const path of matches) {
    const link = document.createElement('a');
    link.href = '../graph/?file=' + encodeURIComponent(path);
    link.textContent = path;
    evidence.append(' ', link);
  }
}

function show(diagram, updateHash = true) {
  if (!diagram || !diagrams.includes(diagram)) return;
  current = diagram;
  title.textContent = diagram.title;
  groupTitle.textContent = diagram.groupLabel;
  kind.textContent = diagram.kind;
  sourceLink.href = 'https://github.com/yohn-jp/codexia/blob/' +
    sourceSha + '/' + diagram.markdown.split('/').map(encodeURIComponent).join('/') + '#L' + diagram.line;
  svgLink.href = diagram.image;
  image.hidden = true;
  loading.hidden = false;
  loading.textContent = 'SVGを読み込んでいます。';
  image.alt = diagram.groupLabel + ' — ' + diagram.title + ' の設計図';
  image.onload = () => {
    image.hidden = false;
    loading.hidden = true;
    viewStatus.textContent = 'SVG表示中：' + diagram.title;
  };
  image.onerror = () => {
    image.hidden = true;
    loading.hidden = false;
    loading.textContent = '図の読み込みに失敗しました。設計書の原文を確認してください。';
    viewStatus.textContent = '図の表示に失敗';
  };
  image.src = diagram.image;
  canvas.scrollTop = 0;
  canvas.scrollLeft = 0;
  setZoom(1);
  for (const [id, button] of buttons) {
    button.hidden = !matches(button.dataset.diagramId);
    if (id === diagram.id) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  for (const group of list.querySelectorAll('.group')) {
    group.hidden = ![...group.querySelectorAll('button')].some(button => !button.hidden);
  }
  renderContract(diagram);
  graphEvidence(diagram);
  if (updateHash && location.hash !== '#' + diagram.id) history.replaceState(null, '', '#' + diagram.id);
}

let sourceSha = '';
function renderContract(diagram) {
  screenContract.replaceChildren();
  const ids = diagram.screenIds ?? [];
  if (!ids.length) {
    screenContract.textContent = 'この図は画面IDを直接識別する設計図ではありません。個別画面との対応は未確認です。';
    return;
  }
  const status = diagram.designStatus || '状態未記載';
  screenContract.append(document.createTextNode(`${ids.join('、')} — 設計状態: ${status}。実装状態は別途確認が必要です。 `));
  const contracts = diagram.screenContracts ?? [];
  if (!contracts.length) {
    screenContract.append(document.createTextNode('画面カタログ行は未取得です。'));
    return;
  }
  screenContract.append(document.createTextNode('画面・操作契約: '));
  for (const [index, contract] of contracts.entries()) {
    if (index) screenContract.append(document.createTextNode('、'));
    const link = document.createElement('a');
    link.href = 'https://github.com/yohn-jp/codexia/blob/' + sourceSha + '/docs/design/SCREEN-CONTROL-CATALOG.md#L' + contract.line;
    link.textContent = `${contract.id} (${contract.status})`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    screenContract.append(link);
  }
}

function matches(id) {
  const diagram = diagrams.find(item => item.id === id);
  if (!diagram) return false;
  const term = query.value.trim().toLocaleLowerCase();
  const groupOk = category.value === 'all' || category.value === diagram.group;
  const haystack = [diagram.id, diagram.title, diagram.groupLabel, diagram.kind, diagram.markdown,
    ...(diagram.screenIds ?? [])].join(' ').toLocaleLowerCase();
  return groupOk && (!term || haystack.includes(term));
}

function filterList() {
  let count = 0;
  for (const [id, button] of buttons) {
    button.hidden = !matches(id);
    if (!button.hidden) count++;
  }
  for (const group of list.querySelectorAll('.group')) {
    group.hidden = ![...group.querySelectorAll('button')].some(button => !button.hidden);
  }
  resultCount.textContent = count ? `${count}件の図` : '条件に一致する図はありません。';
  if (current && buttons.has(current.id) && buttons.get(current.id).hidden) {
    const first = [...buttons.values()].find(button => !button.hidden);
    if (first) show(diagrams.find(item => item.id === first.dataset.diagramId), false);
  }
}
query.addEventListener('input', filterList);
category.addEventListener('change', filterList);

function navigateFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const diagram = diagrams.find(item => item.id === id);
  if (diagram) {
    query.value = '';
    category.value = 'all';
    filterList();
    show(diagram, false);
  } else if (!current) show(diagrams[0], false);
}

function addButtons() {
  for (const diagram of diagrams) {
    if (!groupLabels.has(diagram.group)) groupLabels.set(diagram.group, diagram.groupLabel);
    let group = list.querySelector(`[data-group="${CSS.escape(diagram.group)}"]`);
    if (!group) {
      group = document.createElement('section');
      group.className = 'group';
      group.dataset.group = diagram.group;
      const h3 = document.createElement('h3');
      h3.textContent = diagram.groupLabel;
      group.append(h3);
      list.append(group);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.diagramId = diagram.id;
    button.textContent = diagram.title;
    const name = document.createElement('small');
    name.textContent = `${diagram.id} · ${diagram.kind}`;
    button.append(name);
    button.addEventListener('click', () => show(diagram));
    buttons.set(diagram.id, button);
    group.append(button);
  }
  for (const [id, label] of groupLabels) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    category.append(option);
  }
}

async function loadGraphIndex() {
  try {
    const response = await fetch('../graph/source.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('graph HTTP ' + response.status);
    const data = await response.json();
    if (!/^[a-f0-9]{40}$/.test(data.sourceSha) || !Array.isArray(data.files) ||
        !data.files.every(file => typeof file.path === 'string')) throw new Error('invalid graph index');
    graphIndex = data;
    graphState.textContent = data.sourceSha === sourceSha
      ? 'Graph source SHAはAtlasと一致しています。Graphifyの静的索引に基づく表示です。'
      : 'Graph source SHAがAtlasと異なります。実装リンクは利用できません。';
  } catch {
    graphIndex = null;
    graphState.textContent = 'Graph索引を利用できません。Atlas単体で表示し、実装リンクは未確認です。';
  }
  if (current) graphEvidence(current);
}

async function load() {
  try {
    const response = await fetch('./manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('manifest HTTP ' + response.status);
    const manifest = await response.json();
    if (manifest.format !== 'codexia-architecture-atlas/v1' ||
        !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
        !Array.isArray(manifest.diagrams) || manifest.diagrams.length === 0 ||
        !manifest.diagrams.every(item => /^[a-z]+-\d+$/.test(item.id) &&
          /^svg\/[a-z]+-\d+\.svg$/.test(item.image) &&
          /^docs\/(?:architecture|design|deployment)\/[A-Z0-9-]+\.md$/.test(item.markdown) &&
          Number.isSafeInteger(item.line) && item.line > 0 &&
          typeof item.title === 'string' && typeof item.groupLabel === 'string')) {
      throw new Error('Invalid architecture manifest');
    }
    diagrams = manifest.diagrams;
    sourceSha = manifest.sourceSha;
    document.getElementById('source-sha').textContent = sourceSha;
    document.getElementById('diagram-total').textContent = diagrams.length + ' visual diagrams';
    addButtons();
    filterList();
    navigateFromHash();
    window.addEventListener('hashchange', navigateFromHash);
    void loadGraphIndex();
  } catch {
    loading.textContent = '図の一覧を読み込めませんでした。再読み込みするかGitHubの設計書を参照してください。';
    title.textContent = '図を表示できません';
    viewStatus.textContent = '表示不可';
  }
}

void load();
