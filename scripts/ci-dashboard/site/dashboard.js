import { collect } from './collection.mjs';

const REPOSITORY = 'yohn-jp/codexia';
const API = 'https://api.github.com/repos/' + REPOSITORY + '/';
const WORKFLOW_SOURCE = './verify.yml';

const el = id => document.getElementById(id);
const date = input => { const d = Date.parse(input ?? ''); return Number.isFinite(d) ? d : null; };
const duration = sec => sec == null || !Number.isFinite(sec) ? '—'
  : sec >= 3600 ? (sec / 3600).toFixed(1) + 'h'
    : sec >= 60 ? (sec / 60).toFixed(1) + 'm' : sec.toFixed(0) + 's';
const formatTime = input => input ? new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
}).format(new Date(input)) + ' JST' : '—';
const node = (type, cls, text) => {
  const n = document.createElement(type);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
};
const clear = target => target.replaceChildren();
const validLink = url => typeof url === 'string' &&
  /^https:\/\/github\.com\/yohn-jp\/codexia\/actions\/runs\/\d+(?:\/job\/\d+)?(?:\/attempts\/\d+)?$/u.test(url);
function link(text, url) {
  const n = node(validLink(url) ? 'a' : 'span', '', text);
  if (n.tagName === 'A') { n.href = url; n.target = '_blank'; n.rel = 'noopener noreferrer'; }
  return n;
}
function quantile(numbers, p) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a,b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}
let all = [], selected = null, coverage = {};

async function request(endpoint) {
  const response = await fetch(API + endpoint, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('GitHub Actions metadata unavailable (HTTP ' + response.status + ')');
  return response.json();
}

function contextRow(label, value) {
  const row = node('div', 'context-row');
  row.append(node('span', '', label), node('strong', '', value));
  return row;
}
function renderContext(pr) {
  const out = el('context'); clear(out);
  const verify = pr.runs.find(run => run.id === pr.verifyId);
  out.append(
    contextRow('PR HEAD', pr.sha.slice(0, 12)),
    contextRow('Workflow数', String(pr.runs.length)),
    contextRow('Verify attempt', verify ? '#' + verify.attempt : '—'),
    contextRow('Verify result', verify?.conclusion ?? '—'),
    contextRow('観測期間', formatTime(pr.createdAt)),
    contextRow('収集時刻', formatTime(coverage.observedAt)),
  );
  if (verify?.url) {
    const a = link('GitHubでVerifyを開く', verify.url);
    a.className = 'context-row';
    out.append(a);
  }
}
function renderChain(pr) {
  const list = el('chain'); clear(list);
  const verify = pr.runs.find(run => run.id === pr.verifyId);
  const chain = verify?.chain;
  if (!chain?.verified) {
    list.append(node('li', '', '依存チェーン未確定'));
    el('chain-note').textContent = chain?.reason ?? 'Verifyジョブの実測がありません。';
    return;
  }
  for (const name of chain.names) list.append(node('li', '', name));
  el('chain-note').textContent = chain.reason +
    '。共有Runnerの競合・未記録の外部Workflow依存はこのチェーンに含まれません。';
}
function renderSteps(pr) {
  const target = el('steps'); clear(target);
  const steps = pr.runs.flatMap(run => run.jobs.flatMap(job => job.steps.map(step => ({...step, job: job.name}))))
    .filter(step => step.durationSeconds != null).sort((a,b) => b.durationSeconds - a.durationSeconds).slice(0, 16);
  if (!steps.length) {
    const td = node('td', 'empty', '計測できたステップがありません。'); td.colSpan = 3;
    const tr = node('tr'); tr.append(td); target.append(tr); return;
  }
  for (const step of steps) {
    const tr = node('tr');
    const td = node('td'); td.append(node('span', '', step.name), node('small', 'sub', step.job));
    tr.append(td, node('td', 'phase', step.phase), node('td', 'numeric', duration(step.durationSeconds)));
    target.append(tr);
  }
}
function renderTimeline(pr) {
  const out = el('timeline'); clear(out);
  const jobs = pr.runs.flatMap(run => run.jobs);
  const starts = [pr.createdAt, ...pr.runs.map(run => run.createdAt)].map(date).filter(x => x !== null);
  const ends = jobs.map(job => date(job.completedAt)).filter(x => x !== null);
  if (!starts.length || !ends.length) { out.append(node('p', 'empty', '表示可能なジョブ時刻がありません。')); return; }
  const first = Math.min(...starts), last = Math.max(...ends), span = Math.max(1, last - first);
  const pos = time => Math.min(100, Math.max(0, ((time - first) / span) * 100));
  const slot = (left, right, cls, title) => {
    const bar = node('div', 'bar ' + cls);
    bar.style.left = pos(left) + '%';
    bar.style.width = Math.max(0.15, pos(right) - pos(left)) + '%';
    bar.title = title;
    return bar;
  };
  for (const run of pr.runs) {
    out.append(node('div', 'workflow-header', run.name + ' · attempt ' + run.attempt + ' · ' + (run.conclusion ?? run.status)));
    const rows = [...run.jobs].sort((a,b) => (date(a.createdAt) ?? Infinity) - (date(b.createdAt) ?? Infinity));
    for (const job of rows) {
      const row = node('div', 'timeline-row');
      const left = node('div', 'timeline-label');
      if (job.critical) left.append(node('span', 'flag', '◆ '));
      left.append(link(job.name, job.url));
      left.title = job.name + ' · ' + job.runner;
      const track = node('div', 'timeline-track');
      const created = date(job.createdAt), started = date(job.startedAt), finished = date(job.completedAt);
      if (created !== null && started !== null && started >= created) {
        track.append(slot(created, started, 'wait', 'Queue: ' + duration(job.queueSeconds)));
      }
      if (started !== null && finished !== null && finished >= started) {
        track.append(slot(started, finished, job.conclusion === 'success'
          ? job.critical ? 'critical' : 'exec' : 'failed',
        'Execution: ' + duration(job.durationSeconds)));
      }
      row.append(left, track, node('div', 'timeline-time', duration(job.durationSeconds)));
      out.append(row);
    }
  }
  el('timeline-foot').textContent = 'Range: ' + formatTime(new Date(first).toISOString()) +
    ' — ' + formatTime(new Date(last).toISOString()) + ' · ' + jobs.length +
    ' observed jobs · Skipped / carried jobs are not represented as executed work.';
}
function renderHistory(pr) {
  const target = el('history'); clear(target);
  const sample = all.filter(item => item.complete && item.elapsedSeconds != null &&
    item.runs.every(run => run.timing.comparable));
  el('history-stat').textContent = '比較可能な初回完了 ' + sample.length + '件 / p50 ' +
    duration(quantile(sample.map(item => item.elapsedSeconds), .5)) +
    ' / p90 ' + duration(quantile(sample.map(item => item.elapsedSeconds), .9));
  const values = all.map(item => item.elapsedSeconds).filter(x => x !== null);
  const max = Math.max(1, ...values);
  for (const item of all) {
    const button = node('button', 'history-button' + (item === pr ? ' selected' : ''));
    button.type = 'button';
    button.setAttribute('aria-label', 'PR #' + item.number + ' ' + item.sha.slice(0, 8) + 'を表示');
    button.setAttribute('aria-pressed', item === pr ? 'true' : 'false');
    button.append(node('span', '', '#' + item.number + ' · ' + item.sha.slice(0, 5)));
    const track = node('span', 'history-track');
    const fill = node('span', 'history-fill');
    fill.style.width = item.elapsedSeconds === null ? '0%' : Math.max(1, item.elapsedSeconds / max * 100) + '%';
    track.append(fill);
    button.append(track, node('span', 'history-number', duration(item.elapsedSeconds)));
    button.addEventListener('click', () => {
      selected = item;
      el('pr').value = String(all.indexOf(item));
      render();
    });
    target.append(button);
  }
}
function render() {
  const pr = selected;
  if (!pr) return;
  const verify = pr.runs.find(run => run.id === pr.verifyId);
  el('wall').textContent = duration(pr.elapsedSeconds);
  el('gate').textContent = duration(verify?.timing.certificationSeconds);
  el('runner').textContent = duration(pr.runnerSeconds);
  const queueValues = pr.runs.map(run => run.timing.queueSeconds);
  el('queue').textContent = queueValues.every(v => v !== null)
    ? duration(queueValues.reduce((a,b) => a+b, 0)) : '—';
  renderTimeline(pr);
  renderChain(pr);
  renderSteps(pr);
  renderContext(pr);
  renderHistory(pr);
}
async function main() {
  try {
    const workflowResponse = await fetch(WORKFLOW_SOURCE, {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!workflowResponse.ok) throw new Error('Verify workflow source unavailable (HTTP ' + workflowResponse.status + ')');
    const result = await collect(request, await workflowResponse.text());
    if (result.schema !== 'codexia-ci-dashboard/v1' || !Array.isArray(result.prs)) throw new Error('不正なデータ形式');
    all = result.prs;
    coverage = { ...result.coverage, observedAt: result.observedAt };
    const select = el('pr'); clear(select);
    for (const [index, pr] of all.entries()) {
      const option = node('option', '', '#' + pr.number + ' / ' + pr.sha.slice(0, 9));
      option.value = String(index); select.append(option);
    }
    select.disabled = !all.length;
    if (!all.length) {
      el('status').textContent = coverage.note ?? 'このサンプル範囲にPRデータがありません。';
      for (const id of ['timeline','history','steps']) el(id).replaceChildren(node('p','empty','データなし'));
      return;
    }
    selected = all[0];
    select.value = '0';
    select.addEventListener('change', () => { selected = all[Number(select.value)]; render(); });
    el('status').textContent = 'Collected ' + formatTime(result.observedAt) + ' · ' +
      (coverage.selectedRuns ?? 0) + ' workflows / ' + all.length + ' PR revisions' +
      (coverage.historyTruncated ? ' · HISTORY TRUNCATED' : '') +
      ' · 選択されたWorkflowの観測値であり、全Required Checksの完全証明ではありません。';
    render();
  } catch (error) {
    el('status').textContent = 'CIデータを読み込めませんでした: ' + (error instanceof Error ? error.message : error);
  }
}
main();
