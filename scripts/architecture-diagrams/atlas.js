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

let diagrams = [];
let current = null;
let zoom = 1;
const buttons = new Map();

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

function show(diagram, updateHash = true) {
  if (!diagram || !diagrams.includes(diagram)) return;
  current = diagram;
  title.textContent = diagram.title;
  groupTitle.textContent = diagram.groupLabel;
  kind.textContent = diagram.kind;
  const sourceShaText = document.getElementById('source-sha').textContent.trim();
  const sourceSha = /^[0-9a-fA-F]{7,40}$/.test(sourceShaText) ? sourceShaText : 'HEAD';
  sourceLink.href = 'https://github.com/yohn-jp/codexia/blob/' +
    sourceSha + '/' +
    diagram.markdown.split('/').map(encodeURIComponent).join('/') + '#L' + diagram.line;
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
    if (id === diagram.id) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  if (updateHash && location.hash !== '#' + diagram.id) {
    history.replaceState(null, '', '#' + diagram.id);
  }
}

function navigateFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  const diagram = diagrams.find(item => item.id === id) ?? diagrams[0];
  show(diagram, false);
}

function addButtons() {
  const groups = new Map();
  for (const diagram of diagrams) {
    if (!groups.has(diagram.group)) groups.set(diagram.group, []);
    groups.get(diagram.group).push(diagram);
  }
  for (const groupDiagrams of groups.values()) {
    const group = document.createElement('section');
    group.className = 'group';
    const h3 = document.createElement('h3');
    h3.textContent = groupDiagrams[0].groupLabel;
    group.append(h3);
    for (const diagram of groupDiagrams) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = diagram.title;
      const name = document.createElement('small');
      name.textContent = diagram.kind;
      button.append(name);
      button.addEventListener('click', () => show(diagram));
      buttons.set(diagram.id, button);
      group.append(button);
    }
    list.append(group);
  }
}

async function load() {
  try {
    const response = await fetch('./manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('manifest HTTP ' + response.status);
    const manifest = await response.json();
    if (manifest.format !== 'codexia-architecture-atlas/v1' ||
        !/^[a-f0-9]{40}$/.test(manifest.sourceSha) ||
        !Array.isArray(manifest.diagrams) || manifest.diagrams.length === 0 ||
        !manifest.diagrams.every(item =>
          /^[a-z]+-\d+$/.test(item.id) &&
          /^svg\/[a-z]+-\d+\.svg$/.test(item.image) &&
          /^docs\/(?:architecture|design|deployment)\/[A-Z0-9-]+\.md$/.test(item.markdown) &&
          Number.isSafeInteger(item.line) && item.line > 0 &&
          typeof item.title === 'string' && typeof item.groupLabel === 'string')) {
      throw new Error('Invalid architecture manifest');
    }
    diagrams = manifest.diagrams;
    document.getElementById('source-sha').textContent = manifest.sourceSha;
    document.getElementById('diagram-total').textContent = diagrams.length + ' visual diagrams';
    addButtons();
    navigateFromHash();
    window.addEventListener('hashchange', navigateFromHash);
  } catch {
    loading.textContent = '図の一覧を読み込めませんでした。再読み込みするかGitHubの設計書を参照してください。';
    title.textContent = '図を表示できません';
    viewStatus.textContent = '表示不可';
  }
}

void load();