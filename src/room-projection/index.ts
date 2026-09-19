import { Pool } from "pg";
import type { QueryResultRow } from "pg";
import type { QueryHandle, QueryResult, QueryRow } from "../db/runtime/index.js";
import { reportFailure } from "../failures/index.js";
import { parseAnvilSubject, AnvilSubjectError, type AnvilRoomSubject } from "./contract.js";
import { createRoomAuthorityReader, type RoomAuthorityReader } from "./reader.js";

export * from "./contract.js";
export * from "./control-contract.js";
export {
  createRoomAuthorityReader,
  RoomCapabilityDeniedError,
  RoomNotFoundError,
  type RoomAuthorityReader,
  type RoomEventPage,
  type RoomSnapshot,
} from "./reader.js";

export const ROOM_PROJECTION_URL_ENV = "PASEO_HUB_ANVIL_DATABASE_URL" as const;
export const ROOM_PROJECTION_SUBJECT_ENV = "PASEO_HUB_ANVIL_SUBJECT" as const;

export class RoomAuthorityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomAuthorityConfigError";
  }
}

/**
 * The Hub instance's authenticated read seam into ANVIL Room authority: one
 * bound subject (the ANVIL identity Hub reads as) plus a SELECT-only reader.
 * Hub bearer credentials grant transport access (`rooms:read` scope); this
 * source is what makes reads capability-aware — every projected row passed a
 * durable `room.read` grant check for the bound subject.
 */
export interface RoomAuthoritySource {
  readonly subject: AnvilRoomSubject;
  readonly reader: RoomAuthorityReader;
  close(): Promise<void>;
}

export function createRoomAuthoritySource(
  handle: QueryHandle,
  subject: AnvilRoomSubject,
  close?: () => Promise<void>,
): RoomAuthoritySource {
  return {
    subject,
    reader: createRoomAuthorityReader(handle, subject),
    close: close ?? (() => Promise.resolve()),
  };
}

/**
 * Composition seam: returns undefined when the seam is unconfigured (room
 * operations then answer `room_projection_unavailable`), throws a
 * RoomAuthorityConfigError on a half-configured or malformed binding —
 * misconfiguration fails closed at boot, never at request time.
 */
export function roomAuthorityFromEnvironment(
  env: NodeJS.ProcessEnv,
): RoomAuthoritySource | undefined {
  const url = env[ROOM_PROJECTION_URL_ENV]?.trim();
  const subjectValue = env[ROOM_PROJECTION_SUBJECT_ENV]?.trim();
  if (
    (url === undefined || url.length === 0) &&
    (subjectValue === undefined || subjectValue.length === 0)
  ) {
    return undefined;
  }
  if (
    url === undefined ||
    url.length === 0 ||
    subjectValue === undefined ||
    subjectValue.length === 0
  ) {
    throw new RoomAuthorityConfigError(
      `${ROOM_PROJECTION_URL_ENV} and ${ROOM_PROJECTION_SUBJECT_ENV} must be set together or not at all`,
    );
  }
  let subject: AnvilRoomSubject;
  try {
    subject = parseAnvilSubject(subjectValue);
  } catch (error) {
    if (error instanceof AnvilSubjectError) {
      throw new RoomAuthorityConfigError(
        `${ROOM_PROJECTION_SUBJECT_ENV} is invalid: ${error.message}`,
      );
    }
    throw error;
  }
  const pool = createRoomAuthorityPool(url);
  return createRoomAuthoritySource(new PoolQueryHandle(pool), subject, () => pool.end());
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
