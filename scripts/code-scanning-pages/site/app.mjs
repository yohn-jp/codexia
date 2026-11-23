import { fetchAlerts, makeExport, toCsv } from './api.mjs';

const get = id => document.getElementById(id);
const table = get('alerts');
const status = get('status');
const coverage = get('coverage');
const jsonButton = get('download-json');
const csvButton = get('download-csv');
const tokenInput = get('access-token');
let report = null;

function reset(message, state = 'idle') {
  report = null;
  jsonButton.disabled = true;
  csvButton.disabled = true;
  status.dataset.state = state;
  status.textContent = message;
  coverage.textContent = '未取得 · 対象 refs/heads/main · 全件エクスポート';
  table.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 5;
  cell.textContent = message;
  row.append(cell);
  table.append(row);
}
function cell(text) {
  const td = document.createElement('td');
  td.textContent = String(text ?? '—');
  return td;
}
function render() {
  const items = report.alerts;
  table.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const item of items.slice(0, 100)) {
    const row = document.createElement('tr');
    const id = cell('#' + item.number);
    const link = document.createElement('a');
    link.href = 'https://github.com/yohn-jp/codexia/security/code-scanning/' + item.number;
    link.textContent = '#' + item.number;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    id.replaceChildren(link);
    const location = item.most_recent_instance?.location;
    const position = location?.path ? location.path + (location.start_line ? ':' + location.start_line : '') : '—';
    row.append(id, cell(item.state), cell(item.rule?.security_severity_level ?? item.rule?.severity),
      cell((item.tool?.name ?? 'Unknown') + ' / ' + (item.rule?.id ?? 'Unknown')), cell(position));
    fragment.append(row);
  }
  if (!items.length) {
    const row = document.createElement('tr');
    const item = cell('対象 ref の Code scanning アラートは0件です。');
    item.colSpan = 5;
    row.append(item);
    fragment.append(row);
  }
  table.append(fragment);
  coverage.textContent = items.length + '件取得 · 表示 ' + Math.min(items.length, 100) + '件 · ' +
    report.observedAt + ' · refs/heads/main · GitHub API の全ページ取得済み';
  status.textContent = '取得に成功しました。権限のある利用者のみローカルへ保存してください。';
  status.dataset.state = 'success';
  jsonButton.disabled = false;
  csvButton.disabled = false;
}
function download(content, filename, mediaType) {
  const objectUrl = URL.createObjectURL(new Blob([content], { type: mediaType }));
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
get('credential-form').addEventListener('submit', async event => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  tokenInput.value = '';
  reset('GitHub Code scanning のアラートを取得しています。');
  const load = get('load-alerts');
  load.disabled = true;
  try {
    const alerts = await fetchAlerts(token);
    report = makeExport(alerts);
    render();
  } catch (error) {
    reset(error instanceof Error ? error.message : 'GitHub API の取得に失敗しました。', 'error');
  } finally {
    load.disabled = false;
  }
});
function name(extension) {
  return 'codexia-code-scanning-main-' + report.observedAt.replaceAll(':', '-').replaceAll('.', '-') + '.' + extension;
}
jsonButton.addEventListener('click', () => {
  if (report) download(JSON.stringify(report, null, 2) + '\n', name('json'), 'application/json');
});
csvButton.addEventListener('click', () => {
  if (report) download(toCsv(report.alerts), name('csv'), 'text/csv;charset=utf-8');
});
reset('未取得。トークンを入力してください。');
