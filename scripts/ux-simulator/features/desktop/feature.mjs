import { libraryEdges } from './library.mjs';
import { writingEdges } from './writing.mjs';
import { workspaceEdges } from './workspace.mjs';
import { render } from './view.mjs';
import {
  edge, publishing, publishedText, fixture, owner, entry, library, outline, writing, reading, history, recovery, knowledge, evidence,
  reviews, proposal, modules, publishingPanel, jobs, display, preferences,
} from './state.mjs';

const ownerAt = (at, context) => ({ at, principal: owner, context });
const main = 'tide-studio';

export const features = [{
  id: 'desktop-authoring',
  platform: 'desktop',
  screens: [entry, library, outline, writing, reading, history, recovery, knowledge, evidence,
    reviews, proposal, modules, jobs, display, preferences].map((position) => position.split('/')[0]),
  fixtures: {
    [main]: fixture,
    'anonymous-desktop': { ...fixture, principal: 'ANON' },
    'empty-project': { ...fixture, documents: [], document: null, project: 'synthetic-empty', title: '空の作品', draft: '', committed: '' },
    'module-refused': { ...fixture, moduleEnabled: false },
  },
  scenarios: [
    {
      id: 'desktop-author', label: 'Desktop の作品作業', kind: 'normal', fixture: main,
      journeys: ['ENTRY', 'AUTH', 'LIB', 'OUT', 'WRT', 'READ', 'REC', 'KNO', 'REV', 'TOOL', 'JOB', 'DISPLAY', 'PREF', 'PUB'],
      checkpoints: {
        start: ownerAt(entry), library: ownerAt(library), outline: ownerAt(outline), writer: ownerAt(writing),
        reader: ownerAt(reading), history: ownerAt(history), knowledge: ownerAt(knowledge), evidence: ownerAt(evidence),
        reviews: ownerAt(reviews), proposal: ownerAt(proposal), module: ownerAt(modules),
        publishing: ownerAt(publishingPanel), jobs: ownerAt(jobs), display: ownerAt(display), preferences: ownerAt(preferences),
        recovery: ownerAt(recovery, { journal: 'at-risk', failure: 'quota' }),
      },
    },
    {
      id: 'desktop-login', label: 'Desktop からログイン', kind: 'normal', fixture: 'anonymous-desktop',
      journeys: ['ENTRY', 'AUTH'], checkpoints: { start: { at: entry, principal: 'ANON' } },
    },
    { id: 'desktop-empty', label: '構成が空の作品', kind: 'normal', fixture: 'empty-project', checkpoints: { start: ownerAt(outline) } },
    { id: 'desktop-module-disabled', label: '無効なモジュールと本文への復帰', kind: 'failure',
      fixture: 'module-refused', checkpoints: { start: ownerAt(modules) } },
    { id: 'desktop-db-unavailable', label: '起動時のデータベース不可', kind: 'failure', fixture: main,
      responses: ['unavailable'], checkpoints: { start: ownerAt(entry) } },
  ],
  edges: [
    ...libraryEdges, ...writingEdges, ...workspaceEdges,
    edge(publishingPanel, 'open-reader', 'PUB-01/ready', {
      control: 'TOOL-01.A', source: publishing,
      guard: ({ shared, share, project }) => shared === 'published' && share?.project === project
        || '作者が承認して適用したリンクだけ開けます。',
      handoff: { platform: 'reader', scenario: 'public-reading', checkpoint: 'start' },
      carry: (context) => ({
        publicTitle: context.documents.find(({ id }) => id === context.share.scope)?.title ?? context.title,
        publicText: publishedText(context, context.share.scope),
      }),
    }),
  ],
  render,
}];
