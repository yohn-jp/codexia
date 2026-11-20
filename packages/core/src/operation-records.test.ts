import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILTIN_MODULE_IDS, type ChangeOperation, type ChangeProposal, type SnapshotId } from "@codexia/contracts";
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
    reads: [{ revision: null, path: "manuscript/chapter.md" },{revision:null,path:"manuscript/source.md"}],
    readScopes: [{ revision: "b".repeat(64), prefix: "bible/characters" }],
    readDocumentSets: [{ kind: "scene", parentId: "chapter-id", documentIds: ["scene-a", "scene-b"] }],
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
 assert.equal(operationDigest(operation),operationDigest({...operation,readDocumentSets:[{kind:"scene",parentId:"chapter-id",documentIds:["scene-b","scene-a"]}]}));
 assert.notEqual(operationDigest(operation),operationDigest({...operation,readDocumentSets:[{kind:"scene",parentId:"chapter-id",documentIds:["scene-a"]}]}));
 const reordered=goldenProposal();reordered.evidence![0]!.details={a:true,z:["last",{x:1,y:2}]};
 assert.equal(proposalDigest(proposal),proposalDigest(reordered));
 assert.deepEqual(normalizedProposal(proposal).snapshot,snapshot);
});

test("ranged manuscript writes are included in proposal approval digests", () => {
  const operation = goldenOperation();
  operation.writes[0]!.textChanges = [{ fromUtf16: 2, toUtf16: 4, insert: "new" }];
  const normalized = normalizedOperation(operation);
  assert.deepEqual(normalized.writes[0]!.textChanges, [{ fromUtf16: 2, toUtf16: 4, insert: "new" }]);
  assert.notEqual(operationDigest(operation), operationDigest({
    ...operation,
    writes: [{ ...operation.writes[0]!, textChanges: [{ fromUtf16: 3, toUtf16: 4, insert: "new" }] }],
  }));
  const legacy = goldenOperation();
  assert.equal(normalizedOperation(legacy).writes[0]!.textChanges, undefined);
  assert.doesNotThrow(() => assertPersistedProposal(goldenProposal()), "old operation payloads remain valid");
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

test("proposal evidence may be bound by a covering read scope", () => {
  const proposal = goldenProposal();
  proposal.operations[0]!.reads = [{ path: "manuscript/chapter.md", revision: null }];
  proposal.operations[0]!.readScopes = [{ prefix: "manuscript", revision: "c".repeat(64) }];

  assert.doesNotThrow(() => assertPersistedProposal(proposal));

  proposal.operations[0]!.readScopes = [{ prefix: "bible", revision: "c".repeat(64) }];
  assert.throws(() => assertPersistedProposal(proposal), /exact operation read preconditions/);
});


test("persisted proposal evidence accepts exactly the canonical built-in module identities", () => {
  for (const module of BUILTIN_MODULE_IDS) {
    const proposal = goldenProposal();
    proposal.evidence![0]!.module = module;
    assert.doesNotThrow(() => assertPersistedProposal(proposal), module);
  }
  const proposal = goldenProposal();
  assert.throws(() => assertPersistedProposal({ ...proposal, evidence: [{ ...proposal.evidence![0], module: "unknown-module" }] }), /Invalid proposal evidence record/);
});
