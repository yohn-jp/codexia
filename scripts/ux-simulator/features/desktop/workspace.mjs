import {
  edge, result, failed, choose, leave, draftGuard, titleInput, nextOperation, publishedText, writing, reading, knowledge, evidence,
  reviews, proposal, modules, publishingPanel, jobs, display, preferences, publishing,
} from './state.mjs';

const nodeGuard = ({ node }) => Boolean(node) || '知識候補を選んでください。';
const appliedNotice = '適用した確定 receipt を確認しました。';

function sameProposalScope(context) {
  const target = context.proposalTarget;
  if (!target || target.project !== context.project) return '対象の作品と提案を再確認してください。';
  if (target.kind === 'manuscript' && (target.document !== context.document || target.revision !== context.revision
    || context.draft !== context.committed || context.journal !== 'protected')) return '原稿の確定版と提案の対象を再確認してください。';
  if (target.kind !== 'manuscript' && !context.documents.some(({ id }) => id === target.scope)) return '対象範囲が見つかりません。';
  return true;
}

function applyProposal(context, op = nextOperation(context, 'apply')) {
  const target = context.proposalTarget;
  const next = {
    pendingApply: null, proposalReceipt: { operation: op, ...target, before: undefined, after: undefined },
    proposal: 'applied', failure: null,
  };
  if (target.kind === 'publish') {
    next.shared = 'published';
    next.share = { project: target.project, scope: target.scope, hours: target.hours };
  } else if (target.kind === 'revoke') {
    next.shared = 'revoked';
  } else {
    const revision = context.revision + 1;
    Object.assign(next, {
      committed: target.after, draft: target.after, revision,
      revisionHistory: [...context.revisionHistory, { id: context.revision, text: context.committed }],
      journal: 'protected', receipt: null,
      proposalReceipt: { operation: op, project: target.project, document: target.document, revision },
    });
  }
  return result(context, next, appliedNotice);
}

const presets = {
  writing: ['outline', 'manuscript', 'reference'], research: ['reference', 'manuscript', 'outline'],
  review: ['manuscript', 'reference', 'outline'],
};
const panels = presets.writing;
const nextLayout = (context, change) => result(context, { layout: { ...context.layout, ...change } });
const sourceScope = ({ node, anchor, project, document, revision }) => {
  const reference = anchor ?? node;
  return (reference?.project === project && reference?.document === document && reference.revision === revision)
    || '参照の Revision または文書が古くなりました。';
};
const layoutMode = ['split', 'tabs'];

export const workspaceEdges = [
  edge(knowledge, 'search-knowledge', knowledge, {
    control: 'KNO-01.A', effect: true, guard: (_context, query) => typeof query === 'string', onFailure: failed,
    reduce: (context, query) => result(context, { query, knowledgeLimit: 1, failure: null }),
  }),
  edge(knowledge, 'more-knowledge', knowledge, {
    control: 'KNO-01.A', effect: true, onFailure: failed,
    reduce: (context) => result(context, { knowledgeLimit: 2 }),
  }),
  edge(knowledge, 'open-node', evidence, { guard: nodeGuard, reduce: (context) => result(context, { anchor: null }) }),
  edge(knowledge, 'save-node', evidence, {
    control: 'KNO-01.B', effect: true, guard: (_context, value) => titleInput(value) || '候補名を確認してください。',
    onFailure: (context, response, name) => result(context, { pendingNode: { id: 'synthetic-candidate', name }, failure: response },
      failed(context, response).message),
    reduce: (context, name) => result(context, {
      node: { id: 'synthetic-candidate', name: name.trim(), project: context.project, document: context.document, revision: context.revision },
      pendingNode: null, anchor: null, failure: null,
    }),
  }),
  edge(knowledge, 'back-editor', writing),
  edge(evidence, 'open-evidence', writing, {
    control: 'KNO-02.A', guard: sourceScope, effect: true, onFailure: failed,
    reduce: (context) => result(context, { evidenceVisit: true, selection: context.anchor?.selection ?? [0, Math.min(9, context.committed.length)] }),
  }),
  edge(writing, 'back-evidence', evidence, { guard: (context) => context.evidenceVisit && leave(context) === true
    || '原稿を保護し、参照元を確認してください。', guardDescription: draftGuard,
    reduce: (context) => result(context, { evidenceVisit: false }) }),
  edge(evidence, 'back-knowledge', knowledge),
  edge(evidence, 'back-reading', reading, {
    guard: ({ knowledgeReturn }) => knowledgeReturn === reading || '読書画面から開いた参照ではありません。',
  }),
  edge(evidence, 'change-relation', evidence, {
    control: 'KNO-02.B', guard: (context, value) => titleInput(value) && sourceScope(context) === true
      || '確定した根拠と関係の記述を確認してください。',
    effect: true, onFailure: failed,
    reduce: (context, relation) => result(context, { node: { ...context.node, relation: relation.trim() } }),
  }),
  edge(evidence, 'merge-preview', evidence, {
    control: 'KNO-02.C', guard: nodeGuard,
    reduce: (context) => result(context, { merge: { node: context.node.id, revision: context.revision, digest: 'synthetic-merge-preview' } }),
  }),
  edge(evidence, 'cancel-merge', evidence, { reduce: (context) => result(context, { merge: null }) }),
  edge(evidence, 'merge-node', evidence, {
    control: 'KNO-02.C', effect: true, replayInputs: ['confirm'],
    guard: (context, confirmation) => confirmation === 'confirm' && context.merge?.revision === context.revision
      && context.merge?.node === context.node?.id || '同じ版の統合プレビューを確認してください。',
    onFailure: (context, response) => result(context, { merge: null, failure: response }, failed(context, response).message),
    reduce: (context) => result(context, { merge: null, mergeReceipt: 'synthetic-merge-receipt', failure: null }, '統合の receipt を確認しました。'),
  }),
  edge(reviews, 'open-proposal', proposal, {
    control: 'REV-01.A', effect: true, onFailure: failed,
    guard: ({ proposalHidden }) => !proposalHidden || '非表示の提案は再表示してください。',
    reduce: (context) => result(context, {
      proposalTarget: context.proposalTarget ?? {
        kind: 'manuscript', project: context.project, document: context.document, revision: context.revision,
        before: context.committed, after: '港から灯台の明かりが見えた。',
      },
    }),
  }),
  edge(reviews, 'show-proposal', reviews, { reduce: (context) => result(context, { proposalHidden: false }) }),
  edge(reviews, 'back-editor', writing),
  edge(proposal, 'back-review', reviews),
  edge(proposal, 'approve', proposal, {
    control: 'REV-02.A', effect: true, onFailure: failed,
    guard: (context) => (context.actor === 'author' && context.proposal === 'proposed' && sameProposalScope(context) === true)
      || '作者が未決定の提案と現在の対象を確認してください。',
    reduce: (context) => result(context, { proposal: 'approved' }, '作者が承認しました。適用は別の操作です。'),
  }),
  edge(proposal, 'reject', proposal, {
    control: 'REV-02.A', effect: true, onFailure: failed,
    guard: ({ actor, proposal }) => actor === 'author' && proposal === 'proposed' || '作者が未決定の提案だけを却下できます。',
    reduce: (context) => result(context, { proposal: 'rejected' }, 'サーバー上の提案を却下しました。'),
  }),
  edge(proposal, 'apply', proposal, {
    control: 'REV-02.A', effect: true,
    guard: (context) => (context.actor === 'author' && context.proposal === 'approved' && !context.pendingApply
      && sameProposalScope(context) === true) || '作者の承認と同じ対象が必要です。保留中の適用は再送せず照合してください。',
    onFailure: (context, response) => result(context, {
      failure: response, counter: context.counter + 1,
      pendingApply: ['timeout', 'offline', 'stale'].includes(response)
        ? { operation: nextOperation(context, 'apply'), target: context.proposalTarget } : null,
    }, failed(context, response).message),
    reduce: (context) => applyProposal({ ...context, counter: context.counter + 1 }, nextOperation(context, 'apply')),
  }),
  edge(proposal, 'reconcile-application', proposal, {
    control: 'REV-02.A', effect: true,
    guard: ({ actor, pendingApply, project }) => actor === 'author' && pendingApply?.target.project === project
      || '照合できる作者の適用操作がありません。',
    onFailure: failed,
    reduce: (context) => {
      const target = context.pendingApply.target;
      if (target.kind === 'manuscript' && sameProposalScope(context) !== true) {
        return result(context, {
          pendingApply: null, proposal: 'conflict', failure: 'conflict',
        }, '同じ操作を照合しました。原稿が更新されたため適用結果は競合です。');
      }
      return applyProposal({ ...context, proposalTarget: target }, context.pendingApply.operation);
    },
  }),
  edge(proposal, 'open-applied-document', writing, {
    guard: ({ proposal }) => proposal === 'applied' || '適用結果を照合してください。',
  }),
  edge(proposal, 'hide-proposal', reviews, {
    control: 'REV-02.B', reduce: (context) => result(context, { proposalHidden: true }, 'この一覧だけで非表示にしました。'),
  }),
  edge(modules, 'toggle-module', modules, { reduce: (context) => result(context, { moduleEnabled: !context.moduleEnabled }) }),
  edge(modules, 'module-action', modules, {
    control: 'TOOL-01.A', effect: true, onFailure: failed, replayInputs: ['read', 'compute'],
    guard: ({ moduleEnabled }, action) => moduleEnabled && ['read', 'compute'].includes(action)
      || '有効なモジュールの宣言済み操作を選択してください。',
    reduce: (context, action) => result(context, {
      moduleResult: { action, revision: context.revision, document: context.document }, failure: null,
    }, '合成結果と参照版を確認しました。'),
  }),
  edge(modules, 'module-job', jobs, {
    control: 'TOOL-01.A', effect: true, failure: jobs,
    guard: ({ moduleEnabled, run }) => moduleEnabled && !run || '有効なモジュールと未処理の依頼を確認してください。',
    onFailure: (context, response) => result(context, {
      failure: response, run: ['timeout', 'offline'].includes(response) ? nextOperation(context, 'job') : null,
      counter: context.counter + 1, jobState: 'unknown', jobReturn: modules,
    }, failed(context, response).message),
    reduce: (context) => result(context, { run: nextOperation(context, 'job'), counter: context.counter + 1,
      jobState: 'queued', jobReturn: modules }),
  }),
  edge(modules, 'publishing', publishingPanel, {
    control: 'TOOL-01.A', source: publishing, guard: ({ moduleEnabled }) => moduleEnabled || 'Publishing を有効にしてください。',
  }),
  edge(modules, 'back-editor', writing),
  edge(publishingPanel, 'back-modules', modules),
  edge(publishingPanel, 'publishing-scope', publishingPanel, {
    control: 'TOOL-01.A', source: publishing,
    guard: ({ documents }, scope) => documents.some(({ id }) => id === scope) || '作品内の巻・章・シーンを選んでください。',
    reduce: (context, scope) => result(context, { scope, preview: null }),
  }),
  edge(publishingPanel, 'publishing-export', publishingPanel, {
    control: 'TOOL-01.A', source: publishing, effect: true, onFailure: failed,
    guard: ({ documents, scope }, format) => documents.some(({ id }) => id === scope)
      && ['epub', 'text', 'print'].includes(format) || '対象範囲と形式を選んでください。',
    replayInputs: ['epub', 'text', 'print'],
    reduce: (context, format) => {
      const text = publishedText(context, context.scope);
      return result(context, { preview: { format, text, revision: context.revision } },
        text ? '対象範囲の確定本文を準備しました。' : '対象範囲に本文がありません。');
    },
  }),
  edge(publishingPanel, 'propose-share', proposal, {
    control: 'TOOL-01.A', source: publishing, effect: true, failure: publishingPanel,
    guard: ({ scope, shared, shareUnknown, pendingApply }, hours) => scope && ['1', '24', '72'].includes(hours)
      && !['published', 'proposed'].includes(shared) && !shareUnknown && !pendingApply
      || '対象範囲、有効時間、公開状態を確認してください。',
    replayInputs: ['1', '24', '72'],
    onFailure: (context, response, hours) => result(context, {
      shareUnknown: ['timeout', 'offline'].includes(response)
        ? { operation: nextOperation(context, 'propose-share'), scope: context.scope, hours } : null,
      counter: context.counter + 1,
    }, failed(context, response).message),
    reduce: (context, hours) => result(context, {
      proposal: 'proposed', proposalKind: 'publish', shared: 'proposed', shareUnknown: null,
      proposalTarget: { kind: 'publish', project: context.project, scope: context.scope, hours },
    }),
  }),
  edge(publishingPanel, 'reconcile-share', proposal, {
    control: 'TOOL-01.A', source: publishing, effect: true, guard: ({ shareUnknown }) => Boolean(shareUnknown),
    onFailure: failed,
    reduce: (context) => result(context, {
      proposal: 'proposed', proposalKind: 'publish', shared: 'proposed', shareUnknown: null,
      proposalTarget: { kind: 'publish', project: context.project, scope: context.shareUnknown.scope, hours: context.shareUnknown.hours },
    }, '同じ発行操作から提案を確認しました。'),
  }),
  edge(publishingPanel, 'propose-revoke', proposal, {
    control: 'TOOL-01.A', source: publishing, effect: true,
    guard: ({ shared }) => shared === 'published' || '公開済みのリンクを選んでください。',
    onFailure: failed, reduce: (context) => result(context, {
      proposal: 'proposed', proposalKind: 'revoke',
      proposalTarget: { kind: 'revoke', project: context.share.project, scope: context.share.scope },
    }),
  }),
  edge(proposal, 'back-publishing', publishingPanel, { guard: ({ proposalKind }) => Boolean(proposalKind) }),
  edge(jobs, 'refresh-jobs', jobs, {
    control: 'JOB-01.A', effect: true, onFailure: failed,
    reduce: (context) => result(context, { jobState: context.run ? 'completed' : 'idle', failure: null }),
  }),
  edge(jobs, 'read-notification', jobs, {
    control: 'JOB-01.A', effect: true, onFailure: failed,
    reduce: (context) => result(context, { unread: false, failure: null }),
  }),
  edge(jobs, 'back-editor', writing),
  edge(jobs, 'back-modules', modules, { guard: ({ jobReturn }) => jobReturn === modules || '元の作業は本文です。' }),
  edge(display, 'preset', display, {
    control: 'DISPLAY-01.A', guard: choose(Object.keys(presets), '配置を選んでください。'),
    reduce: (context, preset) => nextLayout(context, { preset, order: presets[preset], hidden: [], arrangement: 'split', status: 'ready' }),
  }),
  edge(display, 'move-panel', display, {
    control: 'DISPLAY-01.A', guard: choose(panels, 'パネルを選んでください。'),
    reduce: (context, panel) => nextLayout(context, { order: [panel, ...context.layout.order.filter((item) => item !== panel)] }),
  }),
  edge(display, 'toggle-panel', display, {
    control: 'DISPLAY-01.A', guard: choose(['outline', 'reference'], '補助パネルを選んでください。'),
    reduce: (context, panel) => nextLayout(context, { hidden: context.layout.hidden.includes(panel)
      ? context.layout.hidden.filter((item) => item !== panel) : [...context.layout.hidden, panel] }),
  }),
  edge(display, 'arrange', display, {
    control: 'DISPLAY-01.A', guard: choose(layoutMode, '分割またはタブを選んでください。'),
    reduce: (context, arrangement) => nextLayout(context, { arrangement }),
  }),
  edge(display, 'resize-panel', display, {
    control: 'DISPLAY-01.A', guard: choose(['narrow', 'standard', 'wide'], '幅を選んでください。'),
    reduce: (context, width) => nextLayout(context, { width }),
  }),
  edge(display, 'theme', display, {
    control: 'DISPLAY-01.A', guard: choose(['light', 'paper', 'dark'], 'テーマを選んでください。'),
    reduce: (context, theme) => result(context, { theme }),
  }),
  edge(display, 'orientation', display, {
    control: 'DISPLAY-01.A', guard: choose(['horizontal', 'vertical'], '組版を選んでください。'),
    reduce: (context, typesetting) => result(context, { typesetting }),
  }),
  edge(display, 'save-layout', display, {
    control: 'DISPLAY-01.A', effect: true,
    onFailure: (context, response) => result(context, { layout: { ...context.layout, preset: 'writing',
      order: presets.writing, arrangement: 'split', width: 'standard', hidden: [], status: 'fallback' } }, failed(context, response).message),
    reduce: (context) => result(context, { savedLayout: { ...context.layout, status: 'ready' },
      layout: { ...context.layout, status: 'ready' } }, 'この表示設定を保存しました。'),
  }),
  edge(display, 'back-editor', writing),
  edge(preferences, 'security', 'CON-00/ready', {
    control: 'PREF-01.A', guard: leave, effect: true, onFailure: failed,
    handoff: { platform: 'console', scenario: 'owner-console', checkpoint: 'start' },
    carry: (context) => ({ desktopResume: context }),
  }),
  edge(preferences, 'back-editor', writing),
];
