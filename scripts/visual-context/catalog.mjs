import assert from 'node:assert/strict';
import { readAuthority } from '../ux-simulator/authority.mjs';
import { designProjection } from '../ux-simulator/design.mjs';
import { createSource } from '../ux-simulator/source.mjs';

// Capture states are checkpoints inside canonical Atlas scenarios. Screen IDs,
// scenario IDs, titles, purpose and controls are resolved from their authorities.
const captureStates = [
  { id: 'library-empty', screenId: 'LIB-01', label: '空の作品一覧' },
  { id: 'library-populated', screenId: 'LIB-01', label: '作品と最近の作業' },
  { id: 'library-error', screenId: 'LIB-01', label: '作品一覧の取得エラー' },
  { id: 'outline-selected', screenId: 'OUT-01', label: '構成と選択中のシーン' },
  { id: 'workspace-writing', screenId: 'WRT-01', label: '執筆ワークスペース' },
  { id: 'workspace-scratch', screenId: 'WRT-01', label: 'スクラッチメモ' },
  { id: 'workspace-reading', screenId: 'READ-01', label: '同じ原稿の読書モード' },
  { id: 'revision-diff', screenId: 'WRT-02', label: 'Revision履歴と差分' },
  { id: 'recoverable-draft', screenId: 'REC-01', label: '保護されたローカルDraft' },
  { id: 'knowledge-search', screenId: 'KNO-01', label: 'Knowledge検索結果' },
  { id: 'knowledge-evidence', screenId: 'KNO-02', label: 'KnowledgeとText Anchorの詳細' },
  { id: 'proposal-list', screenId: 'REV-01', label: '提案レビュー一覧' },
  { id: 'proposal-detail', screenId: 'REV-02', label: '提案の比較と判断' },
  { id: 'module-search', screenId: 'TOOL-01', label: 'モジュールの検索と選択' },
  { id: 'job-inbox', screenId: 'JOB-01', label: '受信箱とジョブ履歴' },
  { id: 'theme-layout', screenId: 'DISPLAY-01', label: '外観と作業面' },
  { id: 'floating-dock', screenId: 'DISPLAY-01', label: 'ドッキングとフローティング配置' },
  { id: 'security-dialog', screenId: 'PREF-01', label: '認証・セキュリティ設定ダイアログ' },
];

function platformReason(platforms) {
  if (platforms.includes('ios')) return 'Native iOS is a separate product surface and is outside this Desktop browser pack.';
  if (platforms.includes('auth')) return 'Authentication-only surfaces are outside the authenticated Desktop workspace capture.';
  if (platforms.includes('reader')) return 'The public Reader is a separate canonical platform, not the Desktop authoring shell.';
  if (platforms.includes('console')) return 'Console is a separate canonical platform outside the Desktop authoring shell.';
  return 'This screen is not part of the Desktop capture platform.';
}

export function loadVisualContextCatalog(repositoryRoot = new URL('../../', import.meta.url)) {
  const source = createSource(repositoryRoot);
  const expected = readAuthority(source);
  const projection = designProjection(source);
  const byScenario = new Map(projection.scenarios.map(scenario => [scenario.id, scenario]));
  const screens = new Map(expected.screens.map(screen => [screen.id, screen]));
  const controlsByScreen = new Map();
  for (const control of expected.controls) {
    if (!controlsByScreen.has(control.screen)) controlsByScreen.set(control.screen, []);
    controlsByScreen.get(control.screen).push(control.label);
  }
  // READ-01 is the selected state of the canonical WRT-01.B read control.
  const readControl = expected.controls.find(control => control.id === 'WRT-01.B');
  if (readControl) controlsByScreen.set('READ-01', [readControl.label]);
  const desktopScreens = expected.screens.filter(screen => screen.adoption === 'adopted' && screen.platforms?.includes('desktop') && screen.id !== 'ENTRY-01');
  const targets = captureStates.map((entry, index) => {
    const screen = screens.get(entry.screenId);
    assert.ok(screen && screen.adoption === 'adopted' && screen.platforms.includes('desktop'), `Capture state ${entry.id} does not point to an adopted Desktop screen`);
    const scenario = projection.scenarios.find(candidate => candidate.screens.includes(entry.screenId) && candidate.platforms.includes('desktop'));
    assert.ok(scenario, `Capture state ${entry.id} has no canonical Desktop Atlas scenario`);
    return {
      ...entry,
      screenTitle: screen.title,
      scenarioId: scenario.id,
      scenarioLabel: scenario.label,
      purpose: screen.purpose,
      operations: [...new Set(controlsByScreen.get(entry.screenId) ?? [])],
      fileName: `${String(index + 1).padStart(3, '0')}-${entry.id}.png`,
    };
  });
  const coveredScreens = new Set(targets.map(target => target.screenId));
  const uncovered = desktopScreens.filter(screen => !coveredScreens.has(screen.id));
  assert.deepEqual(uncovered.map(screen => screen.id), [], 'An adopted Desktop screen is missing from the visual capture states');

  const themeSource = source.read('app/src/theme.ts');
  const themeType = themeSource.match(/export type ThemeMode\s*=\s*([^;]+);/u)?.[1];
  assert.ok(themeType, 'Product ThemeMode source is missing');
  const themes = [...themeType.matchAll(/["']([^"']+)["']/gu)].map(match => match[1]);
  assert.ok(themes.length > 0 && new Set(themes).size === themes.length, 'Product theme modes are invalid');
  const themeControl = source.read('app/src/components/ThemeControl.tsx');
  for (const theme of themes) assert.ok(themeControl.includes(`value="${theme}"`), `ThemeControl is missing product theme ${theme}`);

  const includedScenarioIds = new Set(targets.map(target => target.scenarioId));
  const exclusions = [];
  for (const scenario of projection.scenarios) {
    if (includedScenarioIds.has(scenario.id)) continue;
    if (scenario.id === 'cross-shell') {
      exclusions.push({ id: scenario.id, reason: 'Cross-shell transitions are a journey, not an independently rendered Desktop screen.' });
      continue;
    }
    if (scenario.screens.includes('ENTRY-01')) {
      exclusions.push({ id: 'ENTRY-01', reason: 'The authenticated Desktop entry resolves to the LIB-01 launcher; it has no separate visual surface.' });
      continue;
    }
    if (!scenario.platforms.includes('desktop')) {
      exclusions.push({ id: scenario.id, reason: platformReason(scenario.platforms) });
      continue;
    }
    exclusions.push({ id: scenario.id, reason: 'No independent adopted Desktop surface is present in the capture target set.' });
  }
  for (const screen of expected.screens) {
    if (coveredScreens.has(screen.id) || exclusions.some(item => item.id === screen.id)) continue;
    if (screen.adoption !== 'adopted') exclusions.push({ id: screen.id, reason: 'Not adopted: the screen is a proposal or conceptual grouping.' });
    else if (!screen.platforms?.includes('desktop')) exclusions.push({ id: screen.id, reason: platformReason(screen.platforms ?? []) });
    else if (screen.id === 'ENTRY-01') exclusions.push({ id: screen.id, reason: 'The authenticated Desktop entry resolves to the LIB-01 launcher; it has no separate visual surface.' });
    else assert.fail(`Adopted Desktop screen ${screen.id} has no capture target and no exclusion reason`);
  }
  exclusions.push(
    { id: 'focus-mode', reason: 'No adopted focus-mode screen or active Desktop control exists in the current product catalog.' },
    { id: 'mobile-native-multibrowser-video', reason: 'Mobile/native platforms, additional resolutions, other browsers, and video are outside this pack.' },
    { id: 'ux-simulator-navigation-debug', reason: 'Simulator navigation and developer/debug UI are not product screens and are never captured.' },
  );
  return {
    themes,
    targets,
    exclusions,
    desktopScenarioIds: [...includedScenarioIds],
    sourceDigests: source.hashes(),
  };
}
