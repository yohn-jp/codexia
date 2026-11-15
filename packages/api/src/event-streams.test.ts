import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import { EventStreams } from "./event-streams.js";

class ResponseDouble extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableNeedDrain = false;
  frames: string[] = [];
  failure: "throw" | "slow" | undefined;
  writeHead() {}
  flushHeaders() {}
  write(frame: string): boolean {
    if (this.failure === "throw") throw new Error("socket failed");
    this.frames.push(frame);
    return this.failure !== "slow";
  }
  destroy() { this.destroyed = true; this.emit("close"); }
  end() { this.writableEnded = true; this.emit("finish"); }
  asResponse() { return this as unknown as ServerResponse; }
}

test("event streams bound admission and isolate failed or backpressured consumers", () => {
  const streams = new EventStreams(4);
  const failed = new ResponseDouble(), slow = new ResponseDouble(), errored = new ResponseDouble(), healthy = new ResponseDouble();
  try {
    for (const response of [failed, slow, errored, healthy]) streams.open(response.asResponse(), "no-cache");
    assert.equal(streams.full, true);
    assert.throws(() => streams.open(new ResponseDouble().asResponse(), "no-cache"), /capacity/);
    failed.failure = "throw";
    slow.failure = "slow";
    errored.emit("error", new Error("async socket failure"));
    streams.publish("data: update\n\n");
    assert.equal(failed.destroyed, true);
    assert.equal(slow.destroyed, true);
    assert.equal(errored.destroyed, true);
    assert.deepEqual(healthy.frames, ["data: update\n\n"]);
    assert.equal(streams.full, false);
    streams.publish("data: next\n\n");
    assert.equal(slow.frames.length, 1);
    assert.equal(healthy.frames.length, 2);
  } finally { streams.close(); }
  assert.equal(healthy.writableEnded, true);
});

test("heartbeat and expiration use the same safe lifecycle, finish releases capacity", async () => {
  const streams = new EventStreams(1, 5);
  const response = new ResponseDouble();
  try {
    streams.open(response.asResponse(), "no-cache", ": ok\n\n");
    const heartbeat = new Promise<void>(resolve => {
      const original = response.write.bind(response);
      response.write = frame => { const written = original(frame); if (frame === ": heartbeat\n\n") resolve(); return written; };
    });
    const deadline = setTimeout(() => response.emit("error", new Error("heartbeat deadline")), 100);
    try { await Promise.race([heartbeat, new Promise<void>((_, reject) => response.once("close", () => reject(new Error("closed before heartbeat"))))]); }
    finally { clearTimeout(deadline); }
    response.end();
    assert.equal(streams.full, false);
    const expired = new ResponseDouble();
    const finished = new Promise<void>(resolve => expired.once("finish", resolve));
    streams.open(expired.asResponse(), "no-store", undefined, Date.now());
    const keepAlive = setTimeout(() => expired.end(), 100);
    try { await finished; } finally { clearTimeout(keepAlive); }
    assert.equal(streams.full, false);
  } finally { streams.close(); }
});
