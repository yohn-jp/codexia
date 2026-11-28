import { isPath, jsonRecordLocator } from './source.mjs';

export const platforms = ['desktop', 'ios', 'auth', 'console', 'reader'];
export const catalogPath = 'docs/design/screen-catalog.json';
const nativePath = 'docs/architecture/IOS-SWIFTUI-ARCHITECTURE.sdoc';
const designAdoptions = new Set(['adopted', 'proposal', 'conceptual', 'external']);
const screenForms = new Set(['page', 'panel', 'sheet', 'dialog']);
const screenId = /^[A-Z]+-\d{2}$/;
const ctrlId = /^[A-Z]+-\d{2}\.[A-Z]$/;
const hasText = value => typeof value === 'string' && value.trim() !== '';

export function readAuthority(source) {
  const text = source.read(catalogPath);
  const data = JSON.parse(text);
  if (!Array.isArray(data.screens) || !data.screens.length || !Array.isArray(data.controls)) {
    throw new Error('Invalid screen catalog');
  }
  const locate = jsonRecordLocator(catalogPath, text);
  const byScreen = new Map();
  const screens = data.screens.map(({ id, title, principal, purpose, kind, adoption, form, platforms: scope }) => {
    if (!screenId.test(id) || byScreen.has(id) || !designAdoptions.has(adoption) ||
        ![title, purpose].every(hasText) || (adoption !== 'conceptual' &&
          (![principal, kind].every(hasText) || !screenForms.has(form))) ||
        !Array.isArray(scope) || new Set(scope).size !== scope.length ||
        scope.some(platform => !platforms.includes(platform)) || (adoption === 'adopted') !== Boolean(scope.length)) {
      throw new Error('Invalid screen record: ' + id);
    }
    const location = locate(id);
    const platformSource = scope.includes('ios') ? { path: nativePath, line: 1 } : location;
    const result = { id, title, principal, purpose, kind, adoption, form, platforms: scope, source: location,
      ...(adoption !== 'conceptual' ? { platformSource } : {}) };
    byScreen.set(id, result);
    return result;
  });
  if (byScreen.get('CFG-01')?.adoption !== 'conceptual') throw new Error('Missing CFG-01 classification in design');
  const controlIds = new Set();
  const controls = data.controls.map(({ id, screen, label, prerequisite, success, recovery, references }) => {
    const owner = byScreen.get(screen);
    if (!ctrlId.test(id) || id.split('.')[0] !== screen || !owner || controlIds.has(id) ||
        ![label, prerequisite, success, recovery].every(hasText)) throw new Error('Invalid control record: ' + id);
    if (references !== undefined && (!Array.isArray(references) || references.some(({ path, label }) =>
      !isPath(path) || !path.startsWith('docs/') || !path.endsWith('.sdoc') || !hasText(label)))) {
      throw new Error('Invalid control reference: ' + id);
    }
    controlIds.add(id);
    return { id, screen, label, prerequisite, success, recovery,
      adoption: owner.adoption, platforms: owner.platforms, source: locate(id),
      ...(references ? { references } : {}) };
  });
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
