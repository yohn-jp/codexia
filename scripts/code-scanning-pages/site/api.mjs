// Browser-only Code scanning export. Never send a token to a Pages artifact or third-party endpoint.
export const REPOSITORY = 'yohn-jp/codexia';
export const SOURCE_REF = 'refs/heads/main';
const ENDPOINT = 'https://api.github.com/repos/' + REPOSITORY + '/code-scanning/alerts';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export async function fetchAlerts(token, request = fetch) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('読み取り専用トークンを入力してください。');
  const all = [];
  for (let page = 1; page <= MAX_PAGES + 1; page++) {
    const url = new URL(ENDPOINT);
    url.searchParams.set('ref', SOURCE_REF);
    url.searchParams.set('per_page', String(PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const response = await request(url.href, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const status = response.status;
      const reason = status === 401 ? '認証に失敗しました。トークンを確認してください。'
        : status === 403 ? 'アクセス権限またはAPI利用制限を確認してください（Code scanning alerts: Read-only）。'
          : status === 404 ? '対象のリポジトリまたは Code scanning の利用権限を確認してください。'
            : status === 429 ? 'GitHub API の利用制限に達しました。'
              : 'GitHub API への要求に失敗しました。';
      throw new Error(reason + ' (HTTP ' + status + ')');
    }
    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE || batch.some(item => !item || !Number.isSafeInteger(item.number))) {
      throw new Error('GitHub API のアラート形式が不正です。');
    }
    if (page > MAX_PAGES) {
      if (batch.length) break;
      return all;
    }
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
  }
  // Returning a silently truncated security report would be worse than a failed download.
  throw new Error('アラートが5000件を超えたため、安全な全件ダウンロードを中止しました。');
}

export function makeExport(alerts, observedAt = new Date().toISOString()) {
  return {
    schemaVersion: 'codexia-code-scanning-alerts/v1',
    repository: REPOSITORY,
    ref: SOURCE_REF,
    observedAt,
    alertCount: alerts.length,
    coverage: 'complete',
    source: 'GitHub REST API /code-scanning/alerts',
    alerts,
  };
}

const csvField = value => {
  const text = String(value ?? '');
  // Quoting alone does not prevent formulas from executing in spreadsheet applications.
  const safe = /^[\s]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
};

export function toCsv(alerts) {
  const columns = [
    'number','state','severity','tool','rule_id','path','start_line','end_line',
    'message','commit_sha','created_at','updated_at','fixed_at','dismissed_at','html_url',
  ];
  const data = alerts.map(alert => {
    const instance = alert.most_recent_instance ?? {};
    const location = instance.location ?? {};
    return [
      alert.number, alert.state, alert.rule?.security_severity_level ?? alert.rule?.severity,
      alert.tool?.name, alert.rule?.id, location.path, location.start_line, location.end_line,
      instance.message?.text, instance.commit_sha,
      alert.created_at, alert.updated_at, alert.fixed_at, alert.dismissed_at, alert.html_url,
    ].map(csvField).join(',');
  });
  return '\uFEFF' + [columns.join(','), ...data].join('\r\n') + '\r\n';
}
