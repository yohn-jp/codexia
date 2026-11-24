export const platforms = ['desktop', 'ios', 'auth', 'console', 'reader'];
export const catalogPath = 'docs/design/SCREEN-CONTROL-CATALOG.md';
const nativePath = 'docs/architecture/IOS-SWIFTUI-ARCHITECTURE.md';
const native = new Set('ENTRY-01 LIB-01 OUT-01 WRT-01 WRT-02 READ-01 REC-01 KNO-01 KNO-02 REV-01 REV-02 TOOL-01 JOB-01 DISPLAY-01 PREF-01'.split(' '));

function adoptedPlatforms(id) {
  if (id.startsWith('CON-')) return ['console'];
  if (id.startsWith('AUTH-')) return ['auth'];
  if (id.startsWith('PUB-')) return ['reader'];
  return native.has(id) ? ['desktop', 'ios'] : ['desktop'];
}

const records = (text) => text.split('\n').flatMap((line, index) =>
  !line.startsWith('| ') ? [] : [{ columns: line.slice(1, -1).split(/(?<!\\)\|/u).map((cell) => cell.trim()), line: index + 1 }]);
const clean = (value) => value?.replace(/[*`]/g, '').trim();
const screenId = /^[A-Z]+-\d{2}$/;
const ctrlId = /^[A-Z]+-\d{2}\.[A-Z]$/;

export function readAuthority(source) {
  const text = source.read(catalogPath);
  const screens = [];
  const controls = [];
  const raw = records(text);
  for (const { columns: [id, title, principal, purpose, kind], line } of raw) {
    if (!screenId.test(id)) continue;
    if (!kind || screens.some((entry) => entry.id === id)) throw new Error('Invalid screen record: ' + id);
    const adoption = kind.includes('未採用') ? 'proposal' : id === 'OPS-01' ? 'external' : 'adopted';
    const form = /sheet|シート/i.test(title) ? 'sheet' : /dialog|ダイアログ/i.test(title) ? 'dialog'
      : /panel/i.test(title) ? 'panel' : 'page';
    screens.push({
      id, title: clean(title), principal: clean(principal), purpose: clean(purpose), kind: clean(kind), adoption, form,
      platforms: adoption === 'adopted' ? adoptedPlatforms(id) : [], source: { path: catalogPath, line },
      platformSource: native.has(id) ? { path: nativePath, line: 1 } : { path: catalogPath, line },
    });
  }
  const conceptual = text.split('\n').findIndex((line) => line.includes('CFG-01は表示設定'));
  if (conceptual < 0) throw new Error('Missing CFG-01 classification in design');
  screens.push({ id: 'CFG-01', title: '表示設定・本人セキュリティ設定', purpose: 'DISPLAY-01 と PREF-01 の分類',
    adoption: 'conceptual', platforms: [], source: { path: catalogPath, line: conceptual + 1 } });
  for (const { columns: [id, label, prerequisite, success, recovery], line } of raw) {
    if (!ctrlId.test(id)) continue;
    const screen = id.split('.')[0];
    const owner = screens.find((entry) => entry.id === screen);
    if (!owner || !recovery || controls.some((entry) => entry.id === id)) throw new Error('Invalid control record: ' + id);
    controls.push({
      id, screen, label: clean(label), prerequisite: clean(prerequisite), success: clean(success), recovery: clean(recovery),
      adoption: owner.adoption, platforms: owner.platforms, source: { path: catalogPath, line },
    });
  }
  for (const screen of screens.filter(({ adoption }) => adoption === 'adopted')) {
    if (!controls.some((control) => control.screen === screen.id || (screen.id === 'READ-01' && control.id === 'WRT-01.B'))) {
      throw new Error('Missing controls for adopted screen: ' + screen.id);
    }
  }
  return { screens, controls };
}

const key = ({ id, platform }) => platform + '/' + id;

export function reconcile(expected, observed) {
  const coverage = [];
  const observedTrace = new Set(observed.transitions.filter(({ method }) => method === 'trace').flatMap((e) =>
    [e.screen, e.control].filter(Boolean).map((id) => key({ id, platform: e.platform }))));
  const gaps = new Map((observed.gaps ?? []).map((record) => [key(record), record]));
  if (gaps.size !== (observed.gaps?.length ?? 0)) throw new Error('Duplicate implementation gap');
  const expectedKeys = new Set([...expected.screens, ...expected.controls]
    .filter(({ adoption }) => adoption === 'adopted').flatMap(({ id, platforms }) =>
      platforms.map((platform) => key({ id, platform }))));
  for (const identity of gaps.keys()) {
    if (!expectedKeys.has(identity)) throw new Error('Unknown or excluded implementation gap: ' + identity);
  }
  for (const type of ['screens', 'controls']) {
    const registry = new Map();
    for (const record of observed[type]) {
      if (registry.has(key(record))) throw new Error('Duplicate implementation record: ' + key(record));
      registry.set(key(record), record);
    }
    for (const { id, adoption, platforms: scope, source, kind, screen } of expected[type]) {
      if (adoption !== 'adopted') {
        coverage.push({ id, status: adoption, source, reason: {
          proposal: '未採用提案', conceptual: '独立した画面なし', external: '保護された外部操作面',
        }[adoption] });
        continue;
      }
      for (const platform of [...platforms, 'legacy-mobile-web']) {
        if (!scope.includes(platform)) {
          coverage.push({ id, platform, status: 'excluded', source, reason: platform === 'legacy-mobile-web'
            ? '旧 Mobile Web は廃止対象' : 'この画面の対象プラットフォーム外' });
          continue;
        }
        const identity = key({ id, platform });
        const implementation = registry.get(identity);
        registry.delete(identity);
        const gap = gaps.get(identity);
        const ownerKind = kind ?? expected.screens.find((item) => item.id === screen)?.kind;
        let status;
        let reason;
        if (implementation) {
          if (gap) throw new Error('Conflicting implementation gap and record: ' + identity);
          status = observedTrace.has(identity) ? 'observed' : 'unobserved';
          if (status === 'unobserved') reason = '正規ソースに対応。実行 trace 未確認';
        } else if (gap?.status === 'unimplemented' || (platform !== 'ios' && ownerKind?.includes('未実装'))) {
          status = 'unimplemented';
          reason = gap?.reason ?? '設計台帳で未実装と記載';
        } else {
          status = 'unextracted';
          reason = gap?.reason ?? '対応する正規ソースを抽出できていない';
        }
        coverage.push({ id, platform, status, source, implementation: implementation?.source ?? gap?.source, reason });
      }
    }
    for (const record of registry.values()) {
      if (!record.id.startsWith('impl:')) throw new Error('Unknown or excluded implementation ID: ' + key(record));
      coverage.push({ id: record.id, platform: record.platform, status: 'implementation-only', implementation: record.source,
        reason: '対応する設計 ID がない正規ソース項目' });
    }
  }
  return coverage;
}
