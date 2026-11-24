// The retained in-place migration. The release manifests own the current
// target; these values identify only this particular historical transition.
export default {
  id: 'full-persistence-1-to-2',
  source: { apiEpoch: 1, persistenceFormat: 1 },
  target: { apiEpoch: 2, persistenceFormat: 2 },
  requiredAxes: ['api-epoch', 'persistence-format'],
  optionalAxes: ['oauth-contract'],
  handler: 'snapshot-history-v2',
  fixtureCandidateSource: '601ef70cfa3a03aa1b0e690f0e1b47d3bb300069',
  fixture: 'deploy/ansible/test-epoch-cutover-fixture.sh',
  inputs: [
    'scripts/deployment/cutover/migrations/full-persistence-1-to-2.mjs',
    'deploy/ansible/cutover-snapshot-history-v2.py',
    'deploy/ansible/test-epoch-cutover-fixture.sh',
  ],
};
