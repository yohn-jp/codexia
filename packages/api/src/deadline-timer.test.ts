import assert from "node:assert/strict";
import test from "node:test";
import { scheduleAtDeadline } from "./deadline-timer.js";

test("absolute deadline timer waits after an early timeout callback", () => {
  let clock = 100;
  let scheduled: (() => void) | undefined;
  let delay = -1;
  let calls = 0;
  const fakeSchedule = (callback: () => void, timeout: number): ReturnType<typeof setTimeout> => {
    scheduled = callback;
    delay = timeout;
    return {} as ReturnType<typeof setTimeout>;
  };
  const cancel = scheduleAtDeadline(200, () => { calls++; }, () => clock,
    fakeSchedule,
    () => {});

  assert.equal(delay, 100);
  clock = 199;
  scheduled!();
  assert.equal(calls, 0);
  assert.equal(delay, 1);

  clock = 200;
  scheduled!();
  assert.equal(calls, 1);
  cancel();
  assert.equal(calls, 1);
});
