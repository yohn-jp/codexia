import { presentableDiff } from "@codemirror/merge";

globalThis.onmessage = (event: MessageEvent<{ previous: string; current: string }>) => {
  const { previous, current } = event.data;
  globalThis.postMessage(presentableDiff(previous, current, { scanLimit: 1000, timeout: 50 }));
};
