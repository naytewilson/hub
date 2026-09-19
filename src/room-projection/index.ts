import { readFileSync } from "node:fs";
import { Pool } from "pg";
import type { QueryResultRow } from "pg";
import type { QueryHandle, QueryResult, QueryRow } from "../db/runtime/index.js";
import { reportFailure } from "../failures/index.js";
import { parseAnvilSubject, AnvilSubjectError, type AnvilRoomSubject } from "./contract.js";
import { createNeoReadApiReader } from "./read-api.js";
import { createRoomAuthorityReader, type RoomAuthorityReader } from "./reader.js";

export * from "./contract.js";
export {
  createRoomAuthorityReader,
  RoomCapabilityDeniedError,
  RoomNotFoundError,
  type RoomAuthorityReader,
  type RoomEventPage,
  type RoomSnapshot,
} from "./reader.js";
export { createNeoReadApiReader, NEO_READ_API_TOOLS, type NeoReadApiOptions } from "./read-api.js";

export const ROOM_PROJECTION_URL_ENV = "PASEO_HUB_ANVIL_DATABASE_URL" as const;
export const ROOM_PROJECTION_SUBJECT_ENV = "PASEO_HUB_ANVIL_SUBJECT" as const;
export const ROOM_READ_API_URL_ENV = "PASEO_HUB_ANVIL_READ_API_URL" as const;
export const ROOM_READ_API_TOKEN_ENV = "PASEO_HUB_ANVIL_READ_API_TOKEN" as const;
export const ROOM_READ_API_TOKEN_FILE_ENV = "PASEO_HUB_ANVIL_READ_API_TOKEN_FILE" as const;
export const ROOM_PROJECTION_STALE_MS_ENV = "PASEO_HUB_ANVIL_PROJECTION_STALE_MS" as const;

/**
 * Default freshness budget for the served envelope `stale` flag: a response
 * whose `observed_at` is older than this is reported stale. 30s is well above
 * the projection writer's poll cadence so a healthy pipeline stays fresh.
 */
export const DEFAULT_PROJECTION_STALE_MS = 30_000 as const;

export class RoomAuthorityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomAuthorityConfigError";
  }
}

/**
 * The Hub instance's authenticated read seam into ANVIL Room authority: one
 * bound subject (the ANVIL identity Hub reads as) plus a read-only reader.
 * Hub bearer credentials grant transport access (`rooms:read` scope); this
 * source is what makes reads capability-aware — every projected row passed a
 * durable `room.read` grant check for the bound subject (Hub-side for the
 * Postgres transport, Neo-side for the read-API transport).
 */
export interface RoomAuthoritySource {
  readonly subject: AnvilRoomSubject;
  readonly reader: RoomAuthorityReader;
  /**
   * Freshness budget (ms) for the `stale` flag on served responses:
   * `now - observed_at > staleAfterMs` → stale.
   */
  readonly staleAfterMs: number;
  close(): Promise<void>;
}

export function createRoomAuthoritySource(
  handle: QueryHandle,
  subject: AnvilRoomSubject,
  close?: () => Promise<void>,
  staleAfterMs: number = DEFAULT_PROJECTION_STALE_MS,
): RoomAuthoritySource {
  return createRoomAuthoritySourceForReader(
    createRoomAuthorityReader(handle, subject),
    subject,
    close,
    staleAfterMs,
  );
}

/** Wraps an already-built reader (any transport) as a RoomAuthoritySource. */
export function createRoomAuthoritySourceForReader(
  reader: RoomAuthorityReader,
  subject: AnvilRoomSubject,
  close?: () => Promise<void>,
  staleAfterMs: number = DEFAULT_PROJECTION_STALE_MS,
): RoomAuthoritySource {
  return {
    subject,
    reader,
    staleAfterMs,
    close: close ?? (() => Promise.resolve()),
  };
}

/**
 * Composition seam: returns undefined when the seam is unconfigured (room
 * operations then answer `room_projection_unavailable`), throws a
 * RoomAuthorityConfigError on a half-configured or malformed binding —
 * misconfiguration fails closed at boot, never at request time.
 *
 * Two transports exist; exactly one may be configured:
 * - `PASEO_HUB_ANVIL_READ_API_URL` + token — the Neo-side read API
 *   (`anvil-neo-mcp` MCP surface over the tailnet). This is the ANVIL
 *   deployment path: Hub never opens a direct Postgres connection to Neo
 *   (`:5432` refuses tailnet peers by design).
 * - `PASEO_HUB_ANVIL_DATABASE_URL` — direct SELECT-only Postgres pool, for
 *   authority-adjacent deployments (e.g. Hub co-located with the authority
 *   database). Never usable for the Neo topology.
 */
export function roomAuthorityFromEnvironment(
  env: NodeJS.ProcessEnv,
): RoomAuthoritySource | undefined {
  const config = readAuthorityEnv(env);
  if (config === undefined) return undefined;
  const subject = parseSubjectOrThrow(config.subjectValue);
  const staleAfterMs = parseStaleAfterMs(config.staleMsValue);
  if (config.readApiUrl !== undefined) {
    const token = resolveReadApiToken(config.readApiToken, config.readApiTokenFile);
    return createRoomAuthoritySourceForReader(
      createNeoReadApiReader({
        url: validateReadApiUrl(config.readApiUrl),
        token,
        subject,
      }),
      subject,
      undefined,
      staleAfterMs,
    );
  }
  const databaseUrl = config.databaseUrl;
  if (databaseUrl === undefined) {
    throw new RoomAuthorityConfigError(`${ROOM_PROJECTION_URL_ENV} is required`);
  }
  const pool = createRoomAuthorityPool(databaseUrl);
  return createRoomAuthoritySource(
    new PoolQueryHandle(pool),
    subject,
    () => pool.end(),
    staleAfterMs,
  );
}

interface AuthorityEnvConfig {
  databaseUrl: string | undefined;
  readApiUrl: string | undefined;
  readApiToken: string | undefined;
  readApiTokenFile: string | undefined;
  subjectValue: string;
  staleMsValue: string | undefined;
}

/** Reads + validates the transport selection; undefined means unconfigured. */
function readAuthorityEnv(env: NodeJS.ProcessEnv): AuthorityEnvConfig | undefined {
  const databaseUrl = nonEmpty(env[ROOM_PROJECTION_URL_ENV]);
  const readApiUrl = nonEmpty(env[ROOM_READ_API_URL_ENV]);
  const readApiToken = nonEmpty(env[ROOM_READ_API_TOKEN_ENV]);
  const readApiTokenFile = nonEmpty(env[ROOM_READ_API_TOKEN_FILE_ENV]);
  const subjectValue = nonEmpty(env[ROOM_PROJECTION_SUBJECT_ENV]);
  const staleMsValue = nonEmpty(env[ROOM_PROJECTION_STALE_MS_ENV]);

  const readApiPartial =
    readApiUrl !== undefined || readApiToken !== undefined || readApiTokenFile !== undefined;
  if (
    databaseUrl === undefined &&
    !readApiPartial &&
    subjectValue === undefined &&
    staleMsValue === undefined
  ) {
    return undefined;
  }
  if (databaseUrl !== undefined && readApiPartial) {
    throw new RoomAuthorityConfigError(
      `${ROOM_PROJECTION_URL_ENV} and ${ROOM_READ_API_URL_ENV} select different authority transports; configure exactly one`,
    );
  }
  if (readApiPartial && readApiUrl === undefined) {
    throw new RoomAuthorityConfigError(
      `${ROOM_READ_API_URL_ENV} is required when ${ROOM_READ_API_TOKEN_ENV} or ${ROOM_READ_API_TOKEN_FILE_ENV} is set`,
    );
  }
  if (databaseUrl === undefined && readApiUrl === undefined) {
    throw new RoomAuthorityConfigError(
      `${ROOM_PROJECTION_SUBJECT_ENV} requires ${ROOM_PROJECTION_URL_ENV} or ${ROOM_READ_API_URL_ENV}`,
    );
  }
  if (subjectValue === undefined) {
    throw new RoomAuthorityConfigError(
      `${ROOM_PROJECTION_SUBJECT_ENV} must be set alongside the authority transport`,
    );
  }
  return { databaseUrl, readApiUrl, readApiToken, readApiTokenFile, subjectValue, staleMsValue };
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
        `${ROOM_PROJECTION_SUBJECT_ENV} is invalid: ${error.message}`,
      );
    }
    throw error;
  }
}

function parseStaleAfterMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PROJECTION_STALE_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RoomAuthorityConfigError(
      `${ROOM_PROJECTION_STALE_MS_ENV} must be a positive integer milliseconds value`,
    );
  }
  return parsed;
}

function resolveReadApiToken(token: string | undefined, tokenFile: string | undefined): string {
  if (token !== undefined && token.length > 0 && tokenFile !== undefined && tokenFile.length > 0) {
    throw new RoomAuthorityConfigError(
      `${ROOM_READ_API_TOKEN_ENV} and ${ROOM_READ_API_TOKEN_FILE_ENV} are alternatives; set exactly one`,
    );
  }
  if (token !== undefined && token.length > 0) return token;
  if (tokenFile !== undefined && tokenFile.length > 0) {
    let resolved: string;
    try {
      resolved = readFileSync(tokenFile, "utf8").trim();
    } catch (error) {
      throw new RoomAuthorityConfigError(
        `${ROOM_READ_API_TOKEN_FILE_ENV} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (resolved.length === 0) {
      throw new RoomAuthorityConfigError(`${ROOM_READ_API_TOKEN_FILE_ENV} is empty`);
    }
    return resolved;
  }
  throw new RoomAuthorityConfigError(
    `${ROOM_READ_API_URL_ENV} requires ${ROOM_READ_API_TOKEN_ENV} or ${ROOM_READ_API_TOKEN_FILE_ENV}`,
  );
}

/** HTTPS everywhere; HTTP is allowed only for loopback development. */
function validateReadApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RoomAuthorityConfigError(`${ROOM_READ_API_URL_ENV} is not a URL: ${value}`);
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.toString();
  throw new RoomAuthorityConfigError(
    `${ROOM_READ_API_URL_ENV} must use HTTPS; HTTP is allowed only for loopback development`,
  );
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/** Adapts the raw `pg.Pool` to the repo's driver-neutral QueryHandle. */
class PoolQueryHandle implements QueryHandle {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  query<Row extends QueryRow = QueryRow>(sql: string, params: readonly unknown[] = []) {
    return poolQuery<Row>(this.pool, sql, params);
  }
}

async function poolQuery<Row extends QueryRow>(
  pool: Pick<Pool, "query">,
  sql: string,
  params: readonly unknown[],
): Promise<QueryResult<Row>> {
  const result = await pool.query<Row & QueryResultRow>(sql, [...params]);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

/**
 * A dedicated, session-level read-only pool into the authority database —
 * deliberately separate from Hub's own mutable DatabaseRuntime. Deployments
 * should additionally bind a read-only Postgres role; `default_transaction_read_only`
 * makes the read/projection boundary mechanical even if a future code path
 * attempted a write.
 */
export function createRoomAuthorityPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    max: 4,
    application_name: "paseo-hub-room-projection",
    options:
      "-c default_transaction_read_only=on -c statement_timeout=5000 -c search_path=anvil,public",
    connectionTimeoutMillis: 3_000,
    query_timeout: 5_000,
  });
  pool.on("error", (error) =>
    reportFailure(error, {
      operation: "room-authority.pool",
      component: "room-projection",
    }),
  );
  return pool;
}
