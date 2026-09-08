import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { stopProductionServer } from "./index.js";

class DeferredServer {
  readonly events: string[] = [];
  private closeCallback: ((error?: Error) => void) | undefined;

  close(callback?: (error?: Error) => void): this {
    this.events.push("server.close");
    this.closeCallback = callback;
    return this;
  }

  closeIdleConnections(): void {
    this.events.push("server.closeIdleConnections");
  }

  releaseClose(): void {
    this.events.push("server.close.callback");
    this.closeCallback?.();
  }
}

describe("production shutdown ordering", () => {
  it("starts runtime shutdown before waiting for the listener close callback", async () => {
    const server = new DeferredServer();
    const stopping = stopProductionServer(server, async () => {
      server.events.push("runtime.stop");
      server.releaseClose();
    });

    await stopping;

    assert.deepEqual(server.events, [
      "server.close",
      "server.closeIdleConnections",
      "runtime.stop",
      "server.close.callback",
    ]);
  });
});
