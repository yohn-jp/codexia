import type { ServerResponse } from "node:http";

export class EventStreams {
  private readonly streams = new Map<ServerResponse, () => void>();

  constructor(private readonly limit = 100, private readonly heartbeatMs = 30_000) {}

  get full(): boolean { return this.streams.size >= this.limit; }

  private disconnect(response: ServerResponse): void {
    this.streams.get(response)?.();
    response.destroy();
  }

  private write(response: ServerResponse, frame: string): void {
    if (!this.streams.has(response)) return;
    if (response.destroyed || response.writableEnded) {
      this.streams.get(response)?.();
      return;
    }
    // A disconnected consumer can reconnect; never queue additional frames on a slow socket.
    try {
      if (response.writableNeedDrain || !response.write(frame)) this.disconnect(response);
    } catch { this.disconnect(response); }
  }

  open(response: ServerResponse, cacheControl: string, initialFrame?: string, expiresAt?: number): void {
    if (this.full) throw new Error("Event stream capacity exhausted");
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiration: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      this.streams.delete(response);
      clearInterval(heartbeat);
      clearTimeout(expiration);
    };
    const end = () => {
      cleanup();
      try { response.end(); } catch { response.destroy(); }
    };
    this.streams.set(response, cleanup);
    response.once("close", cleanup);
    response.once("finish", cleanup);
    response.on("error", () => this.disconnect(response));
    try {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": cacheControl,
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      if (initialFrame !== undefined) this.write(response, initialFrame);
      if (!this.streams.has(response)) return;
      heartbeat = setInterval(() => this.write(response, ": heartbeat\n\n"), this.heartbeatMs);
      heartbeat.unref();
      if (expiresAt !== undefined) {
        expiration = setTimeout(end, Math.max(0, Math.min(2_147_483_647, expiresAt - Date.now())));
        expiration.unref();
      }
    } catch { this.disconnect(response); }
  }

  publish(frame: string): void {
    for (const response of this.streams.keys()) this.write(response, frame);
  }

  close(): void {
    for (const [response, cleanup] of this.streams) {
      cleanup();
      try { response.end(); } catch { response.destroy(); }
    }
  }
}
