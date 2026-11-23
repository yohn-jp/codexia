import { collect } from './collection.mjs';
import { comparableHistory } from './analysis.mjs';
import { buildDiagnosticExport } from './diagnostics.mjs';

const REPOSITORY = 'yohn-jp/codexia';
const API = 'https://api.github.com/repos/' + REPOSITORY + '/';
const WORKFLOW_SOURCE = './verify.yml';

const el = id => document.getElementById(id);
const date = input => { const d = Date.parse(input ?? ''); return Number.isFinite(d) ? d : null; };
const duration = sec => sec == null || !Number.isFinite(sec) ? '未計測'
  : sec >= 3600 ? (sec / 3600).toFixed(1) + 'h'
    : sec >= 60 ? (sec / 60).toFixed(1) + 'm' : sec.toFixed(0) + 's';
const formatTime = input => input ? new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
}).format(new Date(input)) + ' JST' : '未計測';
const node = (type, cls, text) => {
  const n = document.createElement(type);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = String(text);
  return n;
};
const clear = target => target.replaceChildren();
function setStatus(message, state = 'info') {
  document.querySelector('.status').dataset.state = state;
  el('status').textContent = message;
}
function setMetric(id, value) {
  const target = el(id);
  const measured = value != null && value !== '' && value !== '未計測';
  target.textContent = measured ? value : '未計測';
  target.dataset.measure = measured ? 'measured' : 'unmeasured';
}
function resetPanels(message = 'この観測範囲にデータがありません。') {
  for (const id of ['timeline', 'history', 'steps']) {
    el(id).replaceChildren(node('p', 'empty', message));
  }
  el('timeline-foot').textContent = '未計測';
  el('history-stat').textContent = '比較可能な観測がありません。';
  el('chain').replaceChildren(node('li', '', '依存チェーン未計測'));
  el('chain-note').textContent = message;
  clear(el('context'));
  for (const id of ['wall', 'gate', 'runner', 'queue']) setMetric(id, null);
  resetSelectionSummary();
}
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
let all = [], selected = null, coverage = {}, verifySource = '';

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
function jobState(job) {
  if (job.conclusion === 'success') return { label: 'success', className: 'success' };
  if (job.conclusion === 'skipped') return { label: 'skipped', className: 'skipped' };
  if (job.conclusion === 'failure' || job.conclusion === 'timed_out') return { label: 'failed', className: 'failed' };
  if (job.conclusion === 'action_required') return { label: 'blocked · action required', className: 'blocked' };
  if (job.conclusion === 'cancelled') return { label: 'cancelled', className: 'cancelled' };
  if (job.conclusion === 'neutral') return { label: 'neutral', className: 'unknown' };
  if (job.conclusion === 'stale') return { label: 'unknown · stale', className: 'unknown' };
  if (job.status === 'in_progress') return { label: 'running', className: 'running' };
  if (job.status === 'queued') return { label: 'queued · cause unknown', className: 'unknown' };
  return { label: job.conclusion ? 'unknown · ' + job.conclusion : 'unknown', className: 'unknown' };
}
function resetSelectionSummary() {
  const result = el('selection-result');
  result.textContent = '未計測';
  result.className = 'summary-state';
  el('selection-bottleneck').textContent = '未計測';
  const href = el('verify-link');
  href.hidden = true;
  href.removeAttribute('href');
}
function renderSelectionSummary(pr) {
  const verify = pr.runs.find(run => run.id === pr.verifyId);
  const result = el('selection-result');
  const state = verify ? jobState(verify) : { label: 'unknown', className: 'unknown' };
  result.textContent = verify?.conclusion ?? verify?.status ?? 'Verify未計測';
  result.className = 'summary-state ' + state.className;
  const bottleneck = verify?.bottleneck;
  el('selection-bottleneck').textContent = bottleneck?.available
    ? bottleneck.leafName + ' · ' + duration(bottleneck.leafSeconds)
    : '未計測 · ' + (bottleneck?.reason ?? verify?.chain?.reason ?? 'Verifyデータがありません');
  const href = el('verify-link');
  if (verify?.url && validLink(verify.url)) {
    href.href = verify.url;
    href.hidden = false;
  } else {
    href.hidden = true;
    href.removeAttribute('href');
  }
}
function renderContext(pr) {
  const out = el('context'); clear(out);
  const verify = pr.runs.find(run => run.id === pr.verifyId);
  out.append(
    contextRow('Executed source SHA', pr.sha),
    contextRow('Workflow数', String(pr.runs.length)),
    contextRow('Verify attempt', verify ? '#' + verify.attempt : '—'),
    contextRow('Verify result', verify?.conclusion ?? '—'),
    contextRow('観測期間', formatTime(pr.createdAt)),
    contextRow('収集時刻', formatTime(coverage.observedAt)),
  );
  const bottleneck = verify?.bottleneck;
  if (bottleneck?.available) {
    out.append(
      contextRow('最後の必須検証', bottleneck.leafName),
      contextRow('検証ジョブ所要時間', duration(bottleneck.leafSeconds)),
      contextRow('検証開始前（ジョブ内）', duration(bottleneck.beforeValidationSeconds)),
      contextRow('うちコンテナ初期化', duration(bottleneck.containerSeconds)),
      contextRow('検証ステップ', duration(bottleneck.validationSeconds)),
      contextRow('検証後〜ジョブ終了', duration(bottleneck.afterValidationSeconds)),
      contextRow('次点ジョブとの差', bottleneck.runnerUpName
        ? duration(bottleneck.runnerUpGapSeconds) + ' / ' + bottleneck.runnerUpName : '—'),
      contextRow('認証処理を含む残り', duration(bottleneck.certificationTailSeconds)),
    );
  } else {
    out.append(contextRow('ボトルネック判定', bottleneck?.reason ?? '未計測'));
  }
  if (verify?.url) {
    const a = link('GitHubでVerifyを開く', verify.url);
    a.className = 'context-row';
    out.append(a);
  }
  const workflows = node('div', 'workflow-runs');
  workflows.append(node('strong', '', 'Observed workflow runs'));
  for (const run of pr.runs) {
    const state = jobState({ status: run.status, conclusion: run.conclusion });
    const item = node('div', 'workflow-run');
    item.append(link(run.name + ' · attempt #' + run.attempt, run.url),
      node('span', 'state ' + state.className, state.label));
    workflows.append(item);
  }
  out.append(workflows);
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
  for (const name of chain.names) {
    const job = verify.jobs.find(item => item.name === name);
    list.append(node('li', '', name + (job ? ' · ' + duration(job.durationSeconds) : '')));
  }
  const bottleneck = verify.bottleneck;
  const near = bottleneck?.available
    ? bottleneck.nearFinish.filter(item => item.name !== bottleneck.leafName) : [];
  el('chain-note').textContent = chain.reason +
    '。共有Runnerの競合・未記録の外部Workflow依存はこのチェーンに含まれません。' +
    (near.length ? ' 最終ジョブの15秒以内に終了した別ジョブ: ' +
      near.map(item => item.name + ' (' + duration(item.behindSeconds) + '差)').join('、') + '。' : '') +
    ' 個別タスク時間はActionsのステップAPIだけでは取得できません。';
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
  if (!starts.length || !ends.length) {
    el('timeline-foot').textContent = '未計測';
    out.append(node('p', 'empty', '表示可能なジョブ時刻がありません。'));
    return;
  }
  const first = Math.min(...starts), last = Math.max(...ends), span = Math.max(1, last - first);
  const pos = time => Math.min(100, Math.max(0, ((time - first) / span) * 100));
  const slot = (left, right, cls, title) => {
    const bar = node('div', 'bar ' + cls);
    bar.style.insetInlineStart = pos(left) + '%';
    bar.style.inlineSize = Math.max(0.15, pos(right) - pos(left)) + '%';
    bar.title = title;
    return bar;
  };
  for (const run of pr.runs) {
    out.append(node('div', 'workflow-header', run.name + ' · attempt ' + run.attempt + ' · ' + (run.conclusion ?? run.status)));
    const rows = [...run.jobs].sort((a,b) => (date(a.createdAt) ?? Infinity) - (date(b.createdAt) ?? Infinity));
    for (const job of rows) {
      const row = node('div', 'timeline-row');
      const left = node('div', 'timeline-label');
      if (job.critical) left.append(node('span', 'flag', 'CHAIN'));
      const state = jobState(job);
      const jobLink = link(job.name, job.url);
      if (job.name.length > 18) jobLink.className = 'timeline-name-long';
      left.append(jobLink, node('span', 'state ' + state.className, state.label));
      left.title = job.name + ' · ' + job.runner;
      const track = node('div', 'timeline-track');
      track.setAttribute('aria-hidden', 'true');
      const created = date(job.createdAt), started = date(job.startedAt), finished = date(job.completedAt);
      if (created !== null && started !== null && started >= created) {
        track.append(slot(created, started, 'wait', 'Queue: ' + duration(job.queueSeconds)));
      }
      if (started !== null && finished !== null && finished >= started) {
        track.append(slot(started, finished, job.conclusion === 'success'
          ? job.critical ? 'critical' : 'exec' : state.className,
        'Execution: ' + duration(job.durationSeconds)));
      }
      row.setAttribute('role', 'group');
      const elapsed = job.conclusion === 'skipped' ? null : job.durationSeconds;
      row.setAttribute('aria-label', job.name + ': ' + state.label + ', ' + duration(elapsed) +
        (job.critical ? ', 推定依存チェーン' : ''));
      row.append(left, track, node('div', 'timeline-time', duration(elapsed)));
      const detailRow = node('details', 'job-steps');
      const summary = node('summary', '', 'Steps (' + job.steps.length + ') · ' + state.label);
      detailRow.append(summary);
      if (job.steps.length) {
        const list = node('ul', 'job-step-list');
        for (const step of job.steps) {
          const stepState = step.conclusion ?? (job.status === 'in_progress' ? 'running' : 'unknown');
          const item = node('li', 'job-step');
          const elapsed = step.conclusion === 'skipped' ? null : step.durationSeconds;
          item.append(node('span', '', step.name), node('span', 'step-meta', stepState + ' · ' + duration(elapsed)));
          list.append(item);
        }
        detailRow.append(list);
      } else detailRow.append(node('p', 'empty', 'Step inventory unavailable.'));
      out.append(row, detailRow);
    }
  }
  el('timeline-foot').textContent = 'Range: ' + formatTime(new Date(first).toISOString()) +
    ' — ' + formatTime(new Date(last).toISOString()) + ' · ' + jobs.length +
    ' observed jobs. Job state labels use the Actions API conclusion; queued cause remains unknown.';
}
function updateSelectionUrl(pr) {
  const url = new URL(window.location.href);
  url.searchParams.set('pr', String(pr.number));
  url.searchParams.set('sha', pr.sha);
  window.history.replaceState(null, '', url);
}
function requestedSelection(items) {
  const url = new URL(window.location.href);
  const pr = Number(url.searchParams.get('pr'));
  const sha = url.searchParams.get('sha');
  const index = items.findIndex(item => item.number === pr && item.sha === sha);
  return index >= 0 ? index : 0;
}
function renderHistory(pr) {
  const target = el('history'); clear(target);
  const sample = comparableHistory(all);
  el('history-stat').textContent = '比較可能な初回完了 ' + sample.length + '件 / p50 ' +
    duration(quantile(sample.map(item => item.elapsedSeconds), .5)) +
    ' / p90 ' + duration(quantile(sample.map(item => item.elapsedSeconds), .9));
  const values = all.map(item => item.elapsedSeconds).filter(x => x !== null);
  const max = Math.max(1, ...values);
  for (const item of all) {
    const button = node('button', 'history-button' + (item === pr ? ' selected' : ''));
    button.type = 'button';
    const status = item.sampleTruncated ? '切り詰められた観測。比較対象外'
      : item.verifyId == null ? 'Verifyを含まない観測。比較対象外'
        : item.complete ? '完了観測' : '未完了観測。比較対象外';
    button.setAttribute('aria-label', 'PR #' + item.number + ' ' + item.sha.slice(0, 8) + ' ' + status + 'を表示');
    button.setAttribute('aria-pressed', item === pr ? 'true' : 'false');
    const label = node('span', 'history-label');
    label.append(node('span', '', '#' + item.number + ' · ' + item.sha.slice(0, 5)));
    if (item.sampleTruncated || item.verifyId == null || !item.complete) {
      label.append(node('small', item.sampleTruncated ? 'history-truncated' : 'history-incomplete',
        item.sampleTruncated ? 'TRUNCATED' : item.verifyId == null ? 'NO VERIFY' : 'INCOMPLETE'));
    }
    button.append(label);
    const track = node('span', 'history-track');
    const fill = node('span', 'history-fill');
    fill.style.width = item.elapsedSeconds === null ? '0%' : Math.max(1, item.elapsedSeconds / max * 100) + '%';
    track.append(fill);
    button.append(track, node('span', 'history-number', duration(item.elapsedSeconds)));
    button.addEventListener('click', () => {
      selected = item;
      el('pr').value = String(all.indexOf(item));
      el('copy-status').textContent = '';
      updateSelectionUrl(item);
      render();
    });
    target.append(button);
  }
}
function render() {
  const pr = selected;
  if (!pr) return;
  const verify = pr.runs.find(run => run.id === pr.verifyId);
  renderSelectionSummary(pr);
  setMetric('wall', duration(pr.elapsedSeconds));
  setMetric('gate', duration(verify?.timing.certificationSeconds));
  setMetric('runner', duration(pr.runnerSeconds));
  const queueValues = pr.runs.map(run => run.timing.queueSeconds);
  setMetric('queue', queueValues.length > 0 && queueValues.every(v => v !== null)
    ? duration(queueValues.reduce((a,b) => a+b, 0)) : null);
  renderTimeline(pr);
  renderChain(pr);
  renderSteps(pr);
  renderContext(pr);
  renderHistory(pr);
}
async function copyDiagnostics() {
  const target = selected;
  if (!target) return;
  const button = el('copy-diagnostics');
  const status = el('copy-status');
  button.disabled = true;
  status.textContent = '診断JSONをコピーしています。';
  try {
    if (!window.isSecureContext || !navigator.clipboard?.writeText) {
      throw new Error('Clipboard API unavailable');
    }
    const diagnostic = buildDiagnosticExport(target, all, coverage, verifySource);
    await navigator.clipboard.writeText(JSON.stringify(diagnostic, null, 2));
    status.textContent = 'PR #' + target.number + ' の診断JSONをコピーしました。';
  } catch {
    status.textContent = 'コピーできませんでした。クリップボード権限とHTTPS接続を確認してください。';
  } finally {
    button.disabled = false;
  }
}

async function loadDashboard() {
  const retry = el('retry');
  const select = el('pr');
  const copyButton = el('copy-diagnostics');
  retry.disabled = true;
  retry.hidden = true;
  copyButton.disabled = true;
  select.disabled = true;
  setStatus('実測データを読み込んでいます。', 'loading');
  all = []; selected = null;
  resetPanels('データを読み込んでいます。');
  try {
    const workflowResponse = await fetch(WORKFLOW_SOURCE, {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!workflowResponse.ok) throw new Error('Verify workflow source unavailable (HTTP ' + workflowResponse.status + ')');
    verifySource = await workflowResponse.text();
    const result = await collect(request, verifySource);
    if (result.schema !== 'codexia-ci-dashboard/v1' || !Array.isArray(result.prs)) throw new Error('不正なデータ形式');
    all = result.prs;
    coverage = { ...result.coverage, observedAt: result.observedAt };
    clear(select);
    for (const [index, pr] of all.entries()) {
      const option = node('option', '', '#' + pr.number + ' / ' + pr.sha.slice(0, 9));
      option.value = String(index); select.append(option);
    }
    select.disabled = !all.length;
    if (!all.length) {
      resetPanels('この観測範囲にPRデータがありません。');
      setStatus((coverage.note ?? 'このサンプル範囲にPRデータがありません。') +
        ' Unresolved runs: ' + (coverage.unresolvedRunCount ?? 0) + '.', 'empty');
      return;
    }
    const index = requestedSelection(all);
    selected = all[index];
    copyButton.disabled = false;
    select.disabled = false;
    select.value = String(index);
    updateSelectionUrl(selected);
    setStatus('Collected ' + formatTime(result.observedAt) + ' · ' +
      (coverage.selectedRuns ?? 0) + ' workflows / ' + all.length + ' PR revisions' +
      (coverage.historyTruncated ? ' · HISTORY TRUNCATED' : '') +
      ((coverage.unresolvedRunCount ?? 0) > 0
        ? ' · ' + coverage.unresolvedRunCount + ' runs excluded: PR/source mapping unresolved' : '') +
      ' · 選択されたWorkflowの観測値であり、全Required Checksの完全証明ではありません。', 'success');
    render();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const guidance = /HTTP 429/u.test(detail)
      ? 'GitHub APIのレート制限に達しました。時間をおいて再試行してください。'
      : /HTTP 403/u.test(detail)
        ? 'GitHub APIへのアクセスが拒否されました。公開リポジトリの状態を確認して再試行してください。'
        : 'データを取得できませんでした。接続状態を確認して再試行してください。';
    resetPanels(guidance);
    setStatus('CIデータを読み込めませんでした。' + guidance + ' (' + detail + ')', 'error');
    retry.hidden = false;
  } finally {
    retry.disabled = false;
  }
}
el('copy-diagnostics').addEventListener('click', copyDiagnostics);
el('retry').addEventListener('click', loadDashboard);
el('pr').addEventListener('change', () => {
  selected = all[Number(el('pr').value)];
  el('copy-status').textContent = '';
  updateSelectionUrl(selected);
  render();
});
loadDashboard();
