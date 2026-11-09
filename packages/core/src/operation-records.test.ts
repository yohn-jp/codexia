import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChangeOperation, ChangeProposal, SnapshotId } from "@codexia/contracts";
import {
  assertPersistedProposal,
  normalizedOperation,
  normalizedProposal,
  operationDigest,
  proposalDigest,
} from "./operation-records.js";

const snapshot: SnapshotId = {projectId:"project-golden",projectVersion:7};

function goldenOperation(): ChangeOperation {
  return {
    evidenceIds: ["evidence-one"],
    message: "Golden operation",
    writes: [{
      encoding: "utf8",
      content: "A line.\n",
      revision: null,
      path: "manuscript/chapter.md",
    }],
    reads: [{ revision: null, path: "manuscript/chapter.md" }],
    readScopes: [{ revision: "b".repeat(64), prefix: "bible/characters" }],
    effect: "manuscript",
    baseProjectVersion: snapshot.projectVersion,
    projectId: snapshot.projectId,
    generation: 7,
    id: "operation-golden",
  } as ChangeOperation;
}

function goldenProposal(): ChangeProposal {
  return {
    source: "module",
    operations: [goldenOperation()],
    snapshot,
    id: "proposal-golden",
    evidence: [{
      details: { z: ["last", { y: 2, x: 1 }], a: true },
      paths: [{ revision: null, path: "manuscript/source.md" }],
      kind: "source_note",
      module: "story",
      snapshot,
      id: "evidence-one",
    }],
  } as ChangeProposal;
}

test("operation and proposal digests bind PostgreSQL identity and canonical evidence",()=>{
 const operation=goldenOperation(),proposal=goldenProposal();
 assert.equal(normalizedOperation(operation).projectId,snapshot.projectId);
 assert.notEqual(operationDigest(operation),operationDigest({...operation,baseProjectVersion:8}));
 const reordered=goldenProposal();reordered.evidence![0]!.details={a:true,z:["last",{x:1,y:2}]};
 assert.equal(proposalDigest(proposal),proposalDigest(reordered));
 assert.deepEqual(normalizedProposal(proposal).snapshot,snapshot);
});

test("persisted proposal validation enforces record binding and safe content", () => {
  const proposal = goldenProposal();
  assert.doesNotThrow(() => assertPersistedProposal(proposal));

  const duplicateOperation = goldenOperation();
  duplicateOperation.writes[0] = { ...duplicateOperation.writes[0]!, path: "manuscript/other.md" };
  assert.throws(() => assertPersistedProposal({ ...proposal, operations: [goldenOperation(), duplicateOperation] }), /binding mismatch/);

  const missingEvidence = { ...proposal, evidence: [] };
  assert.throws(() => assertPersistedProposal(missingEvidence), /Missing proposal evidence reference/);

  const reservedPath = goldenOperation();
  reservedPath.writes[0] = { ...reservedPath.writes[0]!, path: "meta/scriptorium/operations/v1/forged.json" };
  assert.throws(() => assertPersistedProposal({ ...proposal, operations: [reservedPath] }), /Core authority metadata/);
});
