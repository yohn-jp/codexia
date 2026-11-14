import assert from "node:assert/strict";
import { test } from "node:test";
import { protectEditorTransition } from "./transition";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

// Independent oracle from the authoring contract: navigation must not discard
// composition input, an unprotected draft, or a newer generation.
// The event labels model external editor/storage behaviour, not internal flags.
const storageOutcomes = ["stored", "denied", "quota"] as const;
const duringProtection = ["unchanged", "new input"] as const;
const admission: Record<(typeof storageOutcomes)[number], Record<(typeof duringProtection)[number], boolean>> = {
  stored: { unchanged: true, "new input": false },
  denied: { unchanged: false, "new input": false },
  quota: { unchanged: false, "new input": false },
};

test("navigation protection: complete bounded editor/storage event graph", {timeout:5000}, async t => {
  await t.test("composition rejects before storage access", async () => {
    let writes = 0;
    await assert.rejects(protectEditorTransition(() => ({generation:1}), () => { throw new Error("IME active"); },
      async () => { writes++; return true; }), /IME active/);
    assert.equal(writes,0);
  });
  await t.test("empty editor permits navigation without a draft write", async () => {
    let writes = 0, reads = 0;
    await protectEditorTransition(() => null, () => { reads++; }, async () => { writes++; return true; });
    assert.equal(reads,1);
    assert.equal(writes,0);
  });
  for (const capture of ["unchanged","coalesced input"] as const) {
    for (const outcome of storageOutcomes) {
      for (const event of duringProtection) {
        const trace = [capture, "protect", event, outcome].join(" → ");
        await t.test(trace, async () => {
          let editor = {generation:1, markdown:"first"};
          const writes: typeof editor[] = [];
          const started = deferred<void>();
          const storage = deferred<boolean>();
          const completion = protectEditorTransition(() => editor, () => {
            if (capture === "coalesced input") editor = {generation:2,markdown:"coalesced"};
          }, async entry => {
            writes.push({...entry}); started.resolve(); return storage.promise;
          }).then(() => ({allowed:true,error:""}), error => ({allowed:false,error:String(error)}));
          const began = await Promise.race([started.promise.then(() => true), completion.then(() => false)]);
          assert.equal(began,true,"active editor must invoke storage");
          const captured = {...editor};
          if (event === "new input") editor = {generation:captured.generation+1,markdown:"latest"};
          if (outcome === "quota") storage.reject(new Error("quota"));
          else storage.resolve(outcome === "stored");
          const observed = await completion;
          assert.equal(observed.allowed,admission[outcome][event],trace);
          assert.deepEqual(writes,[captured],"only the captured generation may be persisted");
          assert.equal(editor.markdown,event === "new input" ? "latest" : captured.markdown);
          if (outcome === "quota") assert.match(observed.error,/quota/);
          else if (outcome === "denied") assert.match(observed.error,/別タブ/);
          else if (event === "new input") assert.match(observed.error,/本文が更新/);
        });
      }
    }
  }
});
