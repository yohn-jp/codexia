import { presentableDiff } from "@codemirror/merge";

globalThis.onmessage = (event: MessageEvent<{ previous: string; current: string }>) => {
  if (event.origin !== globalThis.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== "object" || typeof data.previous !== "string" ||
      typeof data.current !== "string") return;
  const { previous, current } = data;
  globalThis.postMessage(presentableDiff(previous, current, { scanLimit: 1000, timeout: 50 }));
};
