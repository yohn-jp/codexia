import { collectInventoryPage, collectRevision, selectRuns, identity } from './dashboard/collection.mjs';
import { comparableHistory } from './dashboard/analysis.mjs';
import { buildDiagnosticExport } from './dashboard/diagnostics.mjs';

const REPOSITORY = 'yohn-jp/codexia';
const API = 'https://api.github.com/repos/' + REPOSITORY + '/';
const WORKFLOW_SOURCE = './verify.yml';
const PROFILE_WORKFLOW_SOURCE = './verify-profile.yml';

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
let all = [], selected = null, coverage = {}, verifySource = { verify: '', profile: '' };
let inventoryRuns = [], groups = [], inventoryPage = 0, hasMore = true, reportedTotal = null;
let windowPage = 0, windowBefore = null, inventoryLimitReason = null;
let observed = new Map(), selectionVersion = 0;
const revisionKey = item => item.number + ':' + item.sha;
const groupSignature = group => group.runs.map(run => run.id + '/' + run.run_attempt).join(',');


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
  return index;
}
function renderHistory(pr) {
  const target = el('history'); clear(target);
  const measured = all.filter(item => item.runs.length > 0);
  const sample = comparableHistory(measured);
  el('history-stat').textContent = '比較可能な初回完了 ' + sample.length + '件 / p50 ' +
    duration(quantile(sample.map(item => item.elapsedSeconds), .5)) +
    ' / p90 ' + duration(quantile(sample.map(item => item.elapsedSeconds), .9));
  const values = measured.map(item => item.elapsedSeconds).filter(x => x !== null);
  const max = Math.max(1, ...values);
  for (const item of measured) {
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
    button.addEventListener('click', () => { void chooseRevision(item); });
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

function updateCoverage() {
  const unresolvedRunCount = inventoryRuns.filter(run => identity(run) === null).length;
  coverage = {
    scannedRuns: inventoryRuns.length,
    selectedRuns: all.reduce((sum, item) => sum + item.runs.length, 0),
    selectedPRs: all.length,
    scannedPages: inventoryPage,
    unresolvedRunCount,
    historyTruncated: hasMore || inventoryLimitReason !== null ||
      (reportedTotal !== null && inventoryRuns.length < reportedTotal) || unresolvedRunCount > 0,
    note: 'Public pull_request run inventory. Pages are loaded on demand; only selected PR revisions have job/step observations. Unmapped runs and unavailable GitHub history are not represented as complete.',
    observedAt: new Date().toISOString(),
  };
}
function inventoryStatus() {
  updateCoverage();
  const incomplete = hasMore || inventoryLimitReason !== null ||
    (reportedTotal !== null && inventoryRuns.length < reportedTotal);
  const suffix = inventoryLimitReason ? ' · 履歴取得の制限: ' + inventoryLimitReason
    : hasMore ? ' · 履歴は未取得分があります。全件読み込みを選択してください。'
      : incomplete ? ' · GitHub APIの履歴範囲に未取得分があります。'
        : ' · GitHub APIが返した履歴の読み込みが完了しました。';
  setStatus('Collected ' + formatTime(coverage.observedAt) + ' · ' + inventoryRuns.length +
    ' workflow runs' + (reportedTotal === null ? '' : ' (初期API報告 ' + reportedTotal + ')') +
    ' · ' + all.length +
    ' PR revisions · PR対応不明 ' + coverage.unresolvedRunCount + ' runs' + suffix +
    ' Required Checks全体の証明ではありません。', incomplete ? 'info' : 'success');
  el('load-all').hidden = !hasMore;
}
function refreshInventory() {
  const previous = selected ? revisionKey(selected) : null;
  groups = selectRuns(inventoryRuns);
  all = groups.map(group => {
    const saved = observed.get(revisionKey(group));
    if (saved && saved.signature === groupSignature(group)) return saved.summary;
    return {
      number: group.number, sha: group.sha, createdAt: group.runs[0]?.created_at ?? null,
      complete: false, sampleTruncated: false, elapsedSeconds: null,
      runnerSeconds: null, verifyId: null, runs: [],
    };
  });
  const select = el('pr');
  clear(select);
  for (const [index, group] of groups.entries()) {
    const label = '#' + group.number + ' / ' + group.sha.slice(0, 9) +
      (group.runs.some(run => run.name === 'Verify Codexia') ? '' : ' · NO VERIFY');
    const option = node('option', '', label);
    option.value = String(index);
    select.append(option);
  }
  select.disabled = !all.length;
  const index = previous ? all.findIndex(item => revisionKey(item) === previous) : requestedSelection(all);
  selected = all[index < 0 ? 0 : index] ?? null;
  if (selected) {
    select.value = String(all.indexOf(selected));
    if (selected.runs.length) {
      el('copy-diagnostics').disabled = false;
      render();
    } else {
      el('copy-diagnostics').disabled = true;
      resetPanels('選択したPRのジョブ詳細はまだ取得していません。');
    }
  } else resetPanels('取得した範囲に対応付けられたPRがありません。');
  inventoryStatus();
}
async function appendInventoryPage() {
  const page = windowPage + 1;
  const result = await collectInventoryPage(request, page, windowBefore);
  const seen = new Set(inventoryRuns.map(run => run.id));
  for (const run of result.runs) {
    if (!seen.has(run.id)) { inventoryRuns.push(run); seen.add(run.id); }
  }
  inventoryPage++;
  windowPage = page;
  if (windowBefore === null && result.reportedTotal !== null) reportedTotal = result.reportedTotal;
  hasMore = result.hasMore;
  // GitHub caps filtered Actions searches at 1,000 results. Advance the created_at
  // window rather than pretending that page 10 is the end of repository history.
  if (hasMore && windowPage === 10) {
    const timestamps = result.runs.map(run => Date.parse(run.created_at ?? ''))
      .filter(Number.isFinite);
    const oldest = timestamps.length ? new Date(Math.min(...timestamps))
      .toISOString() : null;
    if (!oldest || (windowBefore !== null && Date.parse(oldest) >= Date.parse(windowBefore))) {
      inventoryLimitReason = '日時カーソルを進められません。未取得履歴があります。';
      hasMore = false;
    } else {
      windowBefore = oldest;
      windowPage = 0;
    }
  }
  refreshInventory();
}
async function chooseRevision(item) {
  if (!item) return;
  const version = ++selectionVersion;
  const key = revisionKey(item);
  const group = groups.find(group => revisionKey(group) === key);
  if (!group) return;
  selected = all.find(candidate => revisionKey(candidate) === key) ?? item;
  el('pr').value = String(all.indexOf(selected));
  el('copy-status').textContent = '';
  updateSelectionUrl(selected);
  const cached = observed.get(key);
  if (cached?.signature === groupSignature(group)) {
    selected = cached.summary;
    el('copy-diagnostics').disabled = false;
    render();
    inventoryStatus();
    return;
  }
  el('copy-diagnostics').disabled = true;
  resetPanels('PR #' + item.number + ' のジョブ詳細を取得しています。');
  setStatus('PR #' + item.number + ' / ' + item.sha.slice(0, 9) + ' のジョブ詳細を取得しています。', 'loading');
  try {
    const summary = await collectRevision(request, verifySource, group);
    if (version !== selectionVersion) return;
    const currentGroup = groups.find(candidate => revisionKey(candidate) === key);
    if (!currentGroup || groupSignature(currentGroup) !== groupSignature(group)) {
      if (currentGroup) await chooseRevision(selected);
      return;
    }
    observed.set(key, { signature: groupSignature(group), summary });
    all = all.map(candidate => revisionKey(candidate) === key ? summary : candidate);
    selected = summary;
    el('copy-diagnostics').disabled = false;
    el('retry').hidden = true;
    render();
    inventoryStatus();
  } catch (error) {
    if (version !== selectionVersion) return;
    const detail = error instanceof Error ? error.message : String(error);
    resetPanels('ジョブ詳細の取得に失敗しました。');
    setStatus('PR #' + item.number + ' のジョブ詳細を取得できませんでした。' + detail, 'error');
    el('retry').hidden = false;
  }
}
async function loadAllInventory() {
  const button = el('load-all');
  button.disabled = true;
  try {
    while (hasMore) {
      await appendInventoryPage();
      // Keep the current selection available without downloading every revision's jobs.
    }
    if (selected && !selected.runs.length) await chooseRevision(selected);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    setStatus('履歴の追加取得が中断されました。' + inventoryRuns.length +
      ' runまでは表示可能です。' + detail, 'error');
  } finally {
    button.disabled = false;
  }
}
async function loadDashboard() {
  const retry = el('retry');
  const select = el('pr');
  retry.disabled = true;
  retry.hidden = true;
  el('load-all').hidden = true;
  el('copy-diagnostics').disabled = true;
  select.disabled = true;
  setStatus('実測データを読み込んでいます。', 'loading');
  ++selectionVersion;
  inventoryRuns = []; groups = []; all = []; selected = null;
  inventoryPage = 0; windowPage = 0; windowBefore = null; inventoryLimitReason = null;
  hasMore = true; reportedTotal = null; observed = new Map();
  resetPanels('データを読み込んでいます。');
  try {
    const [workflowResponse, profileWorkflowResponse] = await Promise.all([
      fetch(WORKFLOW_SOURCE, { signal: AbortSignal.timeout(20_000), redirect: 'error' }),
      fetch(PROFILE_WORKFLOW_SOURCE, { signal: AbortSignal.timeout(20_000), redirect: 'error' }),
    ]);
    if (!workflowResponse.ok) throw new Error('Verify workflow source unavailable (HTTP ' + workflowResponse.status + ')');
    if (!profileWorkflowResponse.ok) throw new Error('Verify profile workflow source unavailable (HTTP ' + profileWorkflowResponse.status + ')');
    [verifySource.verify, verifySource.profile] = await Promise.all([
      workflowResponse.text(), profileWorkflowResponse.text(),
    ]);
    await appendInventoryPage();
    const url = new URL(window.location.href);
    const requestedPR = Number(url.searchParams.get('pr'));
    const requestedSHA = url.searchParams.get('sha');
    if (requestedPR > 0 && /^[a-f0-9]{40}$/iu.test(requestedSHA ?? '')) {
      while (hasMore && !groups.some(group =>
        group.number === requestedPR && group.sha === requestedSHA.toLowerCase())) {
        await appendInventoryPage();
      }
    }
    if (!all.length) {
      resetPanels('取得した範囲に対応付けられたPRがありません。');
      setStatus('公開Actions APIの取得範囲に対応するPRがありません。' +
        ' Unresolved runs: ' + coverage.unresolvedRunCount + '.', 'empty');
      return;
    }
    const match = requestedSelection(all);
    if (requestedPR > 0 && /^[a-f0-9]{40}$/iu.test(requestedSHA ?? '') && match < 0) {
      selected = null;
      select.selectedIndex = -1;
      resetPanels('指定されたPR・リビジョンは取得できたActions履歴にありません。');
      setStatus('指定されたPR #' + requestedPR + ' / ' + requestedSHA.slice(0, 9) +
        ' は取得できたActions履歴にありません。履歴保持・API制限・PR対応不明の可能性があります。', 'empty');
      return;
    }
    await chooseRevision(all[match >= 0 ? match : 0]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const guidance = /HTTP 429/u.test(detail)
      ? 'GitHub APIのレート制限に達しました。時間をおいて再試行してください。'
      : /HTTP 403/u.test(detail)
        ? 'GitHub APIへのアクセスが拒否されました。公開リポジトリの状態を確認して再試行してください。'
        : 'データを取得できませんでした。接続状態を確認して再試行してください。';
    if (!inventoryRuns.length) resetPanels(guidance);
    setStatus('CIデータを読み込めませんでした。' + guidance + ' (' + detail + ')', 'error');
    retry.hidden = false;
  } finally {
    retry.disabled = false;
  }
}
el('copy-diagnostics').addEventListener('click', copyDiagnostics);
el('retry').addEventListener('click', () => {
  if (selected && inventoryRuns.length) void chooseRevision(selected);
  else void loadDashboard();
});
el('load-all').addEventListener('click', () => { void loadAllInventory(); });
el('pr').addEventListener('change', () => {
  void chooseRevision(all[Number(el('pr').value)]);
});
loadDashboard();
