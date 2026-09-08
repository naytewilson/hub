import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compileHubBundle, HubBundleError } from "./bundle.js";

const workflow = `
name: oracle-check
on: manual.run
max_runtime: 10m
steps:
  - id: inspect
    environment: dell
    max_runtime: 5m
    idle_timeout: 1m
    agent: codex
    prompt:
      - text: Inspect the exact dependency API.
`;

function filesWithAgent(agentYaml: string) {
  return [
    {
      path: ".paseo/hub.yml",
      content: `
environments:
  dell:
    kind: daemon
    daemon: dell-general
    cwd: /workspace
agents:
  codex:
    provider: codex
${agentYaml}
`,
    },
    { path: ".paseo/workflows/oracle.yml", content: workflow },
  ];
}

function hasIssue(error: unknown, message: RegExp): boolean {
  return error instanceof HubBundleError && error.issues.some((issue) => message.test(issue.message));
}

describe("stateless external MCP configuration", () => {
  it("compiles a modern stateless Streamable HTTP MCP server onto the selected agent", () => {
    const bundle = compileHubBundle(
      filesWithAgent(`    mcpServers:\n      api-oracle:\n        transport: streamable-http\n        protocolVersion: \"2026-07-28\"\n        url: https://api-oracle.internal/mcp`),
    );
    const agent = bundle.configuration.triggers[0]!.steps[0]!.agent;

    assert.ok(!("selector" in agent));
    if ("selector" in agent) return;
    assert.deepEqual(agent.mcpServers, {
      "api-oracle": {
        transport: "streamable-http",
        protocolVersion: "2026-07-28",
        url: "https://api-oracle.internal/mcp",
      },
    });
  });

  it.each([
    ["legacy SSE", "transport: sse\\n        protocolVersion: \\\"2026-07-28\\\"", /streamable-http|transport/iu],
    ["old protocol", "transport: streamable-http\\n        protocolVersion: \\\"2025-11-25\\\"", /2026-07-28|protocol/iu],
    ["transport session", "transport: streamable-http\\n        protocolVersion: \\\"2026-07-28\\\"\\n        sessionId: sticky", /sessionId|unrecognized/iu],
  ])("rejects %s external MCP configuration", (_label, fields, expected) => {
    const yamlFields = fields.replaceAll("\\n", "\n").replaceAll('\\\"', '"');
    assert.throws(
      () =>
        compileHubBundle(
          filesWithAgent(`    mcpServers:\n      api-oracle:\n        ${yamlFields}`),
        ),
      (error) => hasIssue(error, expected),
    );
  });

  it("reserves the hub MCP server name for execution capabilities", () => {
    assert.throws(
      () =>
        compileHubBundle(
          filesWithAgent(`    mcpServers:\n      hub:\n        transport: streamable-http\n        protocolVersion: \"2026-07-28\"\n        url: https://example.invalid/mcp`),
        ),
      (error) => hasIssue(error, /reserved.*hub|hub.*reserved/iu),
    );
  });
});
