import { platforms as supportedPlatforms } from './model.mjs';

export const catalogPath = 'docs/design/SCREEN-CONTROL-CATALOG.md';
const atlasPath = 'docs/design/SCREEN-STATE-ATLAS.md';
const iosPath = 'docs/architecture/IOS-SWIFTUI-ARCHITECTURE.md';
const catalogId = /^[A-Z]+-\d{2}$/;
const slug = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N}\p{M} _-]/gu, '').replaceAll(' ', '-');
const iosScreens = new Set('ENTRY-01 LIB-01 OUT-01 WRT-01 WRT-02 READ-01 REC-01 KNO-01 KNO-02 REV-01 REV-02 TOOL-01 JOB-01 DISPLAY-01 PREF-01'.split(' '));

function rows(source) {
  return source.split('\n').filter((line) => line.startsWith('| '))
    .map((line) => line.slice(1, -1).split(/(?<!\\)\|/).map((part) => part.trim()));
}

function platformFor(id) {
  if (id.startsWith('CON-')) return ['console'];
  if (id.startsWith('AUTH-')) return ['auth'];
  if (id.startsWith('PUB-')) return ['reader'];
  return iosScreens.has(id) ? ['desktop', 'ios'] : ['desktop'];
}

function permittedPrincipals(id) {
  if (id === 'ENTRY-01') return ['ANON', 'OWNER-API'];
  if (id === 'AUTH-01') return ['ANON', 'OWNER-SESSION'];
  if (id === 'AUTH-02') return ['OWNER-SESSION'];
  if (id === 'CON-03') return ['SETUP', 'OWNER-SESSION'];
  if (id === 'CON-01' || id === 'CON-02') return ['SETUP'];
  if (id.startsWith('CON-')) return ['OWNER-SESSION'];
  if (id === 'PUB-01') return ['SHARE-READER'];
  if (id === 'PREF-01') return ['OWNER-SESSION', 'OWNER-API'];
  return ['OWNER-API'];
}

function add(records, record) {
  if (records.some(({ id }) => id === record.id)) throw new Error('Duplicate authority ID: ' + record.id);
  records.push(record);
}

export function readAuthority(read) {
  const catalog = read(catalogPath);
  const atlas = read(atlasPath);
  const headings = atlas.split('\n').filter((line) => line.startsWith('## '));
  const screens = [];
  const controls = [];
  for (const [id, title, principal, purpose, kind] of rows(catalog)) {
    if (!catalogId.test(id)) continue;
    if (!kind) throw new Error('Incomplete screen authority: ' + id);
    const adoption = kind.includes('未採用') ? 'proposal' : id === 'OPS-01' ? 'external' : 'adopted';
    const atlasHeading = headings.find((heading) => heading.split(' — ')[0].includes(id));
    if (adoption === 'adopted' && !atlasHeading) throw new Error('Missing State Atlas entry: ' + id);
    const platforms = adoption === 'adopted' ? platformFor(id) : [];
    add(screens, {
      id, title, principal, purpose, kind, adoption, platforms,
      permittedPrincipals: adoption === 'adopted' ? permittedPrincipals(id) : [],
      form: id.startsWith('CON-') || id.startsWith('AUTH-') || id === 'PUB-01' ? 'page' : 'platform-defined',
      source: catalogPath + '#全画面カタログとルーティング',
      atlas: atlasHeading ? atlasPath + '#' + slug(atlasHeading.slice(3)) : null,
      platformSource: platforms.includes('ios') ? iosPath + '#3-native-ui-and-navigation' : catalogPath,
    });
  }
  if (!catalog.includes('CFG-01は表示設定')) throw new Error('Missing CFG-01 authority');
  add(screens, {
    id: 'CFG-01', title: '表示設定と本人セキュリティ設定', adoption: 'conceptual', platforms: [],
    purpose: 'DISPLAY-01 と PREF-01 を束ねる概念', source: catalogPath + '#全画面カタログとルーティング',
  });
  for (const [id, label, prerequisite, success, recovery] of rows(catalog)) {
    if (!/^[A-Z]+-\d{2}\.[A-Z]$/.test(id)) continue;
    const screen = id.split('.')[0];
    const owner = screens.find((entry) => entry.id === screen);
    if (!owner || !recovery) throw new Error('Incomplete control authority: ' + id);
    add(controls, {
      id, screen, label, prerequisite, success, recovery, adoption: owner.adoption, platforms: owner.platforms,
      source: catalogPath + '#コントロール導線台帳ボタンフォーム単位',
    });
  }
  if (!screens.length || !controls.length) throw new Error('Missing screen/control catalog');
  for (const screen of screens) {
    if (screen.adoption === 'adopted' && !controls.some((control) => control.screen === screen.id || (screen.id === 'READ-01' && control.id === 'WRT-01.B'))) {
      throw new Error('Missing controls for ' + screen.id);
    }
  }
  return { screens, controls };
}

export function reconcile(authority, features) {
  const claims = new Map();
  const reachable = new Set();
  for (const { id, scenarios } of features) {
    for (const { checkpoints } of scenarios) reachable.add(id + '/' + checkpoints.start.at);
  }
  const edges = features.flatMap((feature) => feature.edges.map((edge) => ({ feature, edge })));
  let changed;
  do {
    changed = false;
    for (const { feature, edge } of edges) {
      if (!reachable.has(feature.id + '/' + edge.from)) continue;
      const target = edge.handoff ? features.find(({ platform, scenarios }) => platform === edge.handoff.platform
        && scenarios.some(({ id }) => id === edge.handoff.scenario)) : feature;
      for (const key of [target && target.id + '/' + edge.to, edge.failure && feature.id + '/' + edge.failure]) {
        if (key && !reachable.has(key)) {
          reachable.add(key);
          changed = true;
        }
      }
    }
  } while (changed);
  for (const feature of features) {
    const { id: featureId, platform, screens, edges: transitions } = feature;
    for (const { checkpoints } of feature.scenarios) {
      for (const { at, principal } of Object.values(checkpoints)) {
        const row = authority.screens.find(({ id }) => id === at.split('/')[0]);
        if (!row?.permittedPrincipals.includes(principal)) throw new Error('Invalid checkpoint principal: ' + at + ' / ' + principal);
      }
    }
    for (const { control } of transitions) {
      if (control && !authority.controls.some((entry) => entry.id === control && entry.adoption === 'adopted' && entry.platforms.includes(platform))) {
        throw new Error('Invalid coverage claim: ' + featureId + ' / ' + control);
      }
    }
    const effective = transitions.filter(({ from }) => reachable.has(featureId + '/' + from));
    for (const [kind, ids] of [
      ['screen', screens],
      ['control', [...new Set(effective.flatMap((edge) => edge.control ? [edge.control] : []))]],
    ]) {
      for (const id of ids) {
        const record = authority[kind + 's'].find((entry) => entry.id === id);
        if (record?.adoption !== 'adopted' || !record.platforms.includes(platform)
          || (kind === 'control' && !screens.includes(record.screen))) {
          throw new Error('Invalid coverage claim: ' + featureId + ' / ' + platform + ' / ' + id);
        }
        const key = platform + '/' + id;
        if (claims.has(key)) throw new Error('Duplicate coverage: ' + key);
        claims.set(key, featureId);
      }
    }
  }
  const records = [...authority.screens, ...authority.controls].flatMap((entry) => {
    const { id, adoption, platforms, source } = entry;
    if (adoption !== 'adopted') {
      const reason = { proposal: '未採用提案', conceptual: '独立した画面なし', external: '保護された外部操作面' }[adoption];
      return [{ id, source, status: adoption, reason }];
    }
    return [...supportedPlatforms, 'legacy-mobile-web'].map((platform) => {
      if (!platforms.includes(platform)) {
        const reason = platform === 'legacy-mobile-web' ? '旧 Mobile Web は廃止対象'
          : platform === 'ios' && platforms.some((value) => ['auth', 'console', 'reader'].includes(value))
            ? 'Native iOS からは外部画面として扱う' : 'この操作面の担当外';
        return { id, platform, source, status: 'excluded', reason };
      }
      const feature = claims.get(platform + '/' + id);
      if (feature && (entry.screen || [...reachable].some((key) => key.startsWith(feature + '/' + id + '/')))) return { id, platform, source, feature, status: 'mapped', evidence: 'DESIGN_MAPPED' };
      return { id, platform, source, status: 'missing', reason: 'この対象の操作モデルが未登録' };
    });
  });
  return { status: records.some(({ status }) => status === 'missing') ? 'partial' : 'mapped', records };
}
