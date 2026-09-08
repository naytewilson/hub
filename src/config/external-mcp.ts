import { z } from "zod";

export const MCP_2026_PROTOCOL_VERSION = "2026-07-28" as const;

const MCP_SERVER_NAME = /^[a-z][a-z0-9_-]*$/u;

export const StatelessExternalMcpServerSchema = z
  .object({
    transport: z.literal("streamable-http"),
    protocolVersion: z.literal(MCP_2026_PROTOCOL_VERSION),
    url: z.string().url(),
  })
  .strict()
  .superRefine((server, context) => {
    const url = new URL(server.url);
    if (url.protocol === "https:") return;
    if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "external MCP URLs must use HTTPS; HTTP is allowed only for loopback development",
    });
  });

export const StatelessExternalMcpServersSchema = z
  .record(z.string(), StatelessExternalMcpServerSchema)
  .superRefine((servers, context) => {
    for (const name of Object.keys(servers)) {
      if (!MCP_SERVER_NAME.test(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "MCP server names must match ^[a-z][a-z0-9_-]*$",
        });
      }
      if (name === "hub") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "the MCP server name 'hub' is reserved for Paseo Hub execution capabilities",
        });
      }
    }
  });

export type StatelessExternalMcpServer = z.infer<typeof StatelessExternalMcpServerSchema>;
export type StatelessExternalMcpServers = Readonly<Record<string, StatelessExternalMcpServer>>;

export interface DaemonHttpMcpServer {
  type: "http";
  url: string;
}

/**
 * Clone and validate the authored external MCP map at a configuration boundary.
 *
 * The protocol version remains a Hub admission invariant. Paseo's daemon wire currently
 * carries only HTTP MCP endpoint details, so provider compatibility with MCP 2026-07-28
 * must be proven independently before production promotion.
 */
export function cloneStatelessExternalMcpServers(
  value: StatelessExternalMcpServers | undefined,
): StatelessExternalMcpServers | undefined {
  if (value === undefined) return undefined;
  return StatelessExternalMcpServersSchema.parse(structuredClone(value));
}

export function materializeDaemonMcpServers(
  value: StatelessExternalMcpServers | undefined,
): Readonly<Record<string, DaemonHttpMcpServer>> {
  if (value === undefined) return {};
  const validated = StatelessExternalMcpServersSchema.parse(structuredClone(value));
  return Object.fromEntries(
    Object.entries(validated)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, server]) => [name, { type: "http" as const, url: server.url }]),
  );
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}
