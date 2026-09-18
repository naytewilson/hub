import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { HubHarness } from "./test-utils/hub-harness.js";

describe("stateless external MCP daemon launch", () => {
  let hub: HubHarness;

  beforeEach(async () => {
    hub = await HubHarness.start();
  }, 120_000);

  afterEach(async () => {
    await hub.stop();
  }, 120_000);

  it("materializes approved MCP 2026 endpoints beside the reserved Hub capability", async () => {
    await hub.connectDaemon();
    const apiOracle = {
      transport: "streamable-http" as const,
      protocolVersion: "2026-07-28" as const,
      url: "https://api-oracle.internal/mcp",
    };

    const result = await hub.dispatch({
      agent: {
        provider: "codex",
        mcpServers: { "api-oracle": apiOracle },
      },
      allowOutputs: [],
    });

    assert.deepEqual(hub.createdAgentLaunch().mcpServers, {
      "api-oracle": {
        type: "http",
        url: "https://api-oracle.internal/mcp",
      },
      hub: {
        type: "http",
        url: `${hub.originUrl()}/agent-executions/${result.execution.id}/mcp`,
        headers: { Authorization: "Bearer <private>" },
      },
    });

    const persisted = await hub.execution(result.execution.id);
    assert.deepEqual(persisted.launchIntent?.agent.mcpServers, {
      "api-oracle": apiOracle,
    });
  });
});
