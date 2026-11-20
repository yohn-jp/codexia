const MAX_TIMEOUT_MS = 2_147_483_647;

type TimeoutHandle = ReturnType<typeof setTimeout>;
type ScheduleTimeout = (callback: () => void, delay: number) => TimeoutHandle;
type CancelTimeout = (timer: TimeoutHandle) => void;

/** Schedule an action for an absolute wall-clock deadline, rechecking when timers fire. */
export function scheduleAtDeadline(
  deadline: number,
  action: () => void,
  now: () => number = Date.now,
  schedule: ScheduleTimeout = (callback, delay) => setTimeout(callback, delay) as TimeoutHandle,
  cancel: CancelTimeout = timer => clearTimeout(timer),
): () => void {
  let timer: TimeoutHandle | undefined;
  let active = true;

  const arm = () => {
    if (!active) return;
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, deadline - now()));
    timer = schedule(() => {
      if (!active) return;
      if (now() < deadline) {
        arm();
        return;
      }
      active = false;
      action();
    }, delay);
    timer.unref?.();
  };

  arm();
  return () => {
    active = false;
    if (timer !== undefined) cancel(timer);
  };
}
