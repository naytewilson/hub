import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { reportFailure } from "../failures/index.js";
import {
  parseAnvilSubject,
  AnvilSubjectError,
  RoomAuthorityConfigError,
  type AnvilRoomSubject,
} from "../room-projection/index.js";
import { createNeoWriteApiGateway } from "./write-api.js";
import { createPoolWriteHandle, createSqlExecutionAuthorityGateway } from "./gateway.js";
import type { ExecutionAuthorityGateway } from "./gateway.js";

export * from "./contract.js";
export * from "./gateway.js";
export {
  createNeoWriteApiGateway,
  NEO_WRITE_API_TOOLS,
  type NeoWriteApiOptions,
} from "./write-api.js";
export {
  createExecutionConvergence,
  type ExecutionConvergence,
  type ExecutionConvergenceObserver,
  type ExecutionConvergenceOptions,
  type ExecutionActionOutcome,
  type ExecutionDescription,
  type MintedExecutionGrant,
  type MintExecutionGrantInput,
  type PerformActionInput,
} from "./machine.js";

/**
 * Explicit opt-in envs for the AUTHORITY WRITE seam. Deliberately separate
 * from the read envs: configuring `PASEO_HUB_ANVIL_DATABASE_URL` (read pool)
 * or the read API must never silently activate writes — the campaign's
 * "no silent production activation" law. The write seam is off unless one of
 * these is set alongside `PASEO_HUB_ANVIL_SUBJECT`:
 *
 * - `PASEO_HUB_ANVIL_WRITE_API_URL` + `PASEO_HUB_ANVIL_WRITE_API_TOKEN`/`_FILE`
 *   — the Neo-side MCP write service (`anvil.execution_resolve`,
 *   `anvil.room_event_append`, `anvil.grant_mint`, `anvil.grant_get`). This is
 *   the production topology: Hub never opens a writable Postgres session to
 *   Neo across the tailnet.
 * - `PASEO_HUB_ANVIL_WRITE_DATABASE_URL` — a dedicated WRITABLE Postgres pool
 *   for authority-adjacent deployments only (Hub co-located with anvil_core).
 */
export const EXECUTION_WRITE_API_URL_ENV = "PASEO_HUB_ANVIL_WRITE_API_URL" as const;
export const EXECUTION_WRITE_API_TOKEN_ENV = "PASEO_HUB_ANVIL_WRITE_API_TOKEN" as const;
export const EXECUTION_WRITE_API_TOKEN_FILE_ENV = "PASEO_HUB_ANVIL_WRITE_API_TOKEN_FILE" as const;
export const EXECUTION_WRITE_DATABASE_URL_ENV = "PASEO_HUB_ANVIL_WRITE_DATABASE_URL" as const;
export const EXECUTION_AUTHORITY_SUBJECT_ENV = "PASEO_HUB_ANVIL_SUBJECT" as const;

export interface ExecutionAuthorityWriteSource {
  readonly subject: AnvilRoomSubject;
  readonly gateway: ExecutionAuthorityGateway;
  close(): Promise<void>;
}

/**
 * Composition seam mirroring `roomAuthorityFromEnvironment`: undefined means
 * the write seam is unconfigured (convergence stays inert — observe calls
 * resolve unbound, control ops answer execution_not_bound/unavailable); a
 * half-configured or conflicting binding throws at boot, never at request
 * time.
 */
export function executionAuthorityFromEnvironment(
  env: NodeJS.ProcessEnv,
): ExecutionAuthorityWriteSource | undefined {
  const apiUrl = nonEmpty(env[EXECUTION_WRITE_API_URL_ENV]);
  const apiToken = nonEmpty(env[EXECUTION_WRITE_API_TOKEN_ENV]);
  const apiTokenFile = nonEmpty(env[EXECUTION_WRITE_API_TOKEN_FILE_ENV]);
  const databaseUrl = nonEmpty(env[EXECUTION_WRITE_DATABASE_URL_ENV]);
  const subjectValue = nonEmpty(env[EXECUTION_AUTHORITY_SUBJECT_ENV]);

  const apiPartial = apiUrl !== undefined || apiToken !== undefined || apiTokenFile !== undefined;
  // Only an explicit WRITE var activates the seam — the subject env is shared
  // with the read path, so its presence alone must never turn writes on.
  if (!apiPartial && databaseUrl === undefined) return undefined;
  if (apiUrl !== undefined && databaseUrl !== undefined) {
    throw new RoomAuthorityConfigError(
      `${EXECUTION_WRITE_API_URL_ENV} and ${EXECUTION_WRITE_DATABASE_URL_ENV} select different write transports; configure exactly one`,
    );
  }
  if (apiPartial && apiUrl === undefined) {
    throw new RoomAuthorityConfigError(
      `${EXECUTION_WRITE_API_URL_ENV} is required when ${EXECUTION_WRITE_API_TOKEN_ENV} or ${EXECUTION_WRITE_API_TOKEN_FILE_ENV} is set`,
    );
  }
  const subject = parseSubjectOrThrow(subjectValue);
  if (apiUrl !== undefined) {
    return {
      subject,
      gateway: createNeoWriteApiGateway({
        url: apiUrl,
        token: resolveWriteApiToken(apiToken, apiTokenFile),
        subject,
      }),
      close: () => Promise.resolve(),
    };
  }
  const pool = createExecutionWriterPool(databaseUrl!);
  const handle = createPoolWriteHandle(pool);
  return {
    subject,
    gateway: createSqlExecutionAuthorityGateway({
      handle,
      transact: (operation) => handle.transaction(operation),
      subject,
    }),
    close: () => pool.end(),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

function parseSubjectOrThrow(subjectValue: string | undefined): AnvilRoomSubject {
  try {
    return parseAnvilSubject(subjectValue ?? "");
  } catch (error) {
    if (error instanceof AnvilSubjectError) {
      throw new RoomAuthorityConfigError(
        `${EXECUTION_AUTHORITY_SUBJECT_ENV} is invalid: ${error.message}`,
      );
    }
    throw error;
  }
}

function resolveWriteApiToken(token: string | undefined, tokenFile: string | undefined): string {
  if (token !== undefined && tokenFile !== undefined) {
    throw new RoomAuthorityConfigError(
      `${EXECUTION_WRITE_API_TOKEN_ENV} and ${EXECUTION_WRITE_API_TOKEN_FILE_ENV} are alternatives; set exactly one`,
    );
  }
  if (token !== undefined) return token;
  if (tokenFile !== undefined) {
    let resolved: string;
    try {
      resolved = readFileSync(tokenFile, "utf8").trim();
    } catch (error) {
      throw new RoomAuthorityConfigError(
        `${EXECUTION_WRITE_API_TOKEN_FILE_ENV} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (resolved.length === 0) {
      throw new RoomAuthorityConfigError(`${EXECUTION_WRITE_API_TOKEN_FILE_ENV} is empty`);
    }
    return resolved;
  }
  throw new RoomAuthorityConfigError(
    `${EXECUTION_WRITE_API_URL_ENV} requires ${EXECUTION_WRITE_API_TOKEN_ENV} or ${EXECUTION_WRITE_API_TOKEN_FILE_ENV}`,
  );
}

/**
 * Dedicated WRITABLE pool into the authority database — deliberately separate
 * from the projection pool (which pins `default_transaction_read_only=on`).
 * Only reachable via `PASEO_HUB_ANVIL_WRITE_DATABASE_URL`; production Hub
 * deployments must use the Neo write API transport instead.
 */
export function createExecutionWriterPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 4,
    application_name: "paseo-hub-execution-convergence",
    options: "-c statement_timeout=5000 -c search_path=anvil,public",
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
  });
  pool.on("error", (error) =>
    reportFailure(error, {
      operation: "execution-authority.pool",
      component: "execution-convergence",
    }),
  );
  return pool;
}
