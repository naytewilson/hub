/**
 * Correlation Envelope V1 (wire `anvil.correlation.v2`) — Hub carrier.
 *
 * Frozen contract: CORRELATION_ENVELOPE_V1.md (contract version 1.0.0),
 * normative JSON Schema vendored at ./correlation-envelope-v1.schema.json.
 *
 * AUTHORITY LAW (non-negotiable):
 * - ANVIL/Postgres is the SOLE minter/advancer of `execution_binding_id` /
 *   `binding_generation`. This module cannot mint, increment, infer, or
 *   advance them — there is deliberately no code path that does.
 * - Hub copies ANVIL-held values verbatim (`correlation_id`, `execution_id`,
 *   `causation_id`). It validates SHAPE only; malformed inbound values are
 *   dropped to null, never "repaired" into plausible values.
 * - Hub does NOT hold `binding_generation` anywhere (the internal
 *   `binding_status` active|replaced|released is not a generation number and
 *   is never converted into one). The binding pair travels together or not at
 *   all, so Hub envelopes carry `execution_binding_id: null` /
 *   `binding_generation: null`. Freshness of Hub projections is UNKNOWN —
 *   freshness is evaluated by consumers against live authority, never carried.
 * - NAMESPACE COLLISION (Phase B recon, PROVEN): two different `executionId`
 *   namespaces exist in Hub. I4 control operations use the Hub
 *   `agent_executions` durable id; the envelope's `execution_id` is ONLY the
 *   ANVIL `execution_bindings.execution_id`. The Hub-native id travels solely
 *   as `plane_identity.hub_execution_id` — never mapped into `execution_id`.
 * - No prompt payload: the envelope carries identity/metadata only. The key
 *   set is fixed; unknown fields are preserved by carriers, never invented.
 */

import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

/** Wire schema version. Anything else is carried opaquely, evaluated UNKNOWN. */
export const CORRELATION_ENVELOPE_WIRE_SCHEMA = "anvil.correlation.v2" as const;

/** Producers that emit Hub-built envelopes. */
export const HUB_PROJECTION_PRODUCER = "hub:projection" as const;
export const HUB_CONTROL_PRODUCER = "hub:control" as const;

/**
 * Plane-native ids the producer ALREADY holds. A key is included ONLY when
 * the value is native to the producer's own plane — never mapped, guessed,
 * or converted cross-plane. Absent keys are omitted, not null.
 */
export interface CorrelationPlaneIdentity {
  hub_execution_id?: string | null;
  control_operation_id?: string | null;
  paseo_agent_id?: string | null;
  paseo_server_id?: string | null;
  sieve_request_id?: string | null;
  provider_receipt_id?: string | null;
}

/** The v2 envelope. Null fields are present with null value (except inside plane_identity). */
export interface CorrelationEnvelopeV2 {
  schema: typeof CORRELATION_ENVELOPE_WIRE_SCHEMA;
  correlation_id: string | null;
  causation_id: string | null;
  campaign_id: string | null;
  task_ref: string | null;
  execution_id: string | null;
  execution_binding_id: string | null;
  binding_generation: number | null;
  producer: string;
  observed_at: string;
  idempotency_key: string | null;
  source_ref: string | null;
  plane_identity: CorrelationPlaneIdentity | null;
}

/** Fixed key order for digesting (contract §4). */
export const CORRELATION_ENVELOPE_KEY_ORDER: readonly (keyof CorrelationEnvelopeV2)[] = [
  "schema",
  "correlation_id",
  "causation_id",
  "campaign_id",
  "task_ref",
  "execution_id",
  "execution_binding_id",
  "binding_generation",
  "producer",
  "observed_at",
  "idempotency_key",
  "source_ref",
  "plane_identity",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAMPAIGN_RE = /^[a-z0-9][a-z0-9._:-]*$/;

/** UUID shape check with lowercase normalization. Malformed → null (never repaired). */
export function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cappedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * Shape-only validation, mirroring ref/evaluate.py `validate`. Returns a list
 * of violation strings (empty = valid shape). Never invents values: a
 * violation is reported, not repaired.
 */
export function validateEnvelopeShape(value: unknown): string[] {
  const violations: string[] = [];
  if (!isRecord(value)) return ["envelope is not an object"];
  const env = value;
  if (env["schema"] !== CORRELATION_ENVELOPE_WIRE_SCHEMA) {
    violations.push(`unknown schema: ${JSON.stringify(env["schema"])}`);
  }
  for (const field of [
    "correlation_id",
    "task_ref",
    "execution_id",
    "execution_binding_id",
  ] as const) {
    const v = env[field];
    if (v !== null && v !== undefined && normalizeUuid(v) === null) {
      violations.push(`malformed uuid field ${field}: ${JSON.stringify(v)}`);
    }
  }
  const gen = env["binding_generation"];
  if (
    gen !== null &&
    gen !== undefined &&
    (typeof gen !== "number" || !Number.isInteger(gen) || gen < 1)
  ) {
    violations.push(`malformed binding_generation: ${JSON.stringify(gen)}`);
  }
  const bid = env["execution_binding_id"] ?? null;
  if ((bid === null) !== (gen === null || gen === undefined)) {
    violations.push("partial binding identity: binding id and generation must travel together");
  }
  if (typeof env["producer"] !== "string" || env["producer"].length === 0) {
    violations.push("missing producer");
  }
  if (typeof env["observed_at"] !== "string" || env["observed_at"].length === 0) {
    violations.push("missing observed_at");
  }
  return violations;
}

export interface HubEnvelopeInput {
  correlation_id: unknown;
  causation_id?: unknown;
  campaign_id?: unknown;
  task_ref?: unknown;
  /** ANVIL `execution_bindings.execution_id` ONLY — never a Hub-native id. */
  execution_id: unknown;
  /**
   * Hub does not hold `binding_generation`: pass null/omitted. The pair is
   * atomic by construction — a partial pair is dropped wholesale, never
   * emitted half-formed and never "completed" by inference.
   */
  binding?: { execution_binding_id: unknown; binding_generation: unknown } | null;
  producer: string;
  /** Emission time. A Date is rendered as RFC 3339 UTC; never backdated. */
  observed_at: Date | string;
  idempotency_key?: unknown;
  /** Opaque pointer to the source record (cursor, event id, receipt id). */
  source_ref?: unknown;
  plane_identity?: CorrelationPlaneIdentity | null;
}

/**
 * Build a v2 envelope from values the producer already holds. Copies verbatim
 * after shape checks; malformed values become null. Returns null only when
 * the required `producer`/`observed_at` are absent — callers fail closed.
 */
export function buildCorrelationEnvelope(input: HubEnvelopeInput): CorrelationEnvelopeV2 | null {
  if (typeof input.producer !== "string" || input.producer.length === 0) return null;
  let observedAt: string | null = null;
  if (input.observed_at instanceof Date) {
    observedAt = input.observed_at.toISOString();
  } else if (typeof input.observed_at === "string" && input.observed_at.length > 0) {
    observedAt = input.observed_at;
  }
  if (observedAt === null) return null;

  let execution_binding_id: string | null = null;
  let binding_generation: number | null = null;
  if (input.binding) {
    const bid = normalizeUuid(input.binding.execution_binding_id);
    const gen = input.binding.binding_generation;
    if (bid !== null && typeof gen === "number" && Number.isInteger(gen) && gen >= 1) {
      execution_binding_id = bid;
      binding_generation = gen;
    }
    // Partial or malformed pair: dropped wholesale. Never inferred, never repaired.
  }

  const campaignRaw = cappedString(input.campaign_id, 128);
  const plane = input.plane_identity ?? null;

  return {
    schema: CORRELATION_ENVELOPE_WIRE_SCHEMA,
    correlation_id: normalizeUuid(input.correlation_id),
    causation_id: cappedString(input.causation_id, 256),
    campaign_id: campaignRaw !== null && CAMPAIGN_RE.test(campaignRaw) ? campaignRaw : null,
    task_ref: normalizeUuid(input.task_ref),
    execution_id: normalizeUuid(input.execution_id),
    execution_binding_id,
    binding_generation,
    producer: input.producer,
    observed_at: observedAt,
    idempotency_key: cappedString(input.idempotency_key, 256),
    source_ref: cappedString(input.source_ref, 512),
    plane_identity:
      plane === null
        ? null
        : (Object.fromEntries(
            Object.entries(plane)
              .filter(([, v]) => v !== null && v !== undefined)
              .map(([k, v]) => [k, String(v)]),
          ) as CorrelationPlaneIdentity),
  };
}

/**
 * Wire shape for Hub-emitted v2 envelopes. `.passthrough()` preserves unknown
 * fields per contract §4 (carriers preserve, consumers ignore) — parsers must
 * not strip what a newer producer added.
 */
export const CorrelationEnvelopeV2Schema = z
  .object({
    schema: z.literal(CORRELATION_ENVELOPE_WIRE_SCHEMA),
    correlation_id: z.string().uuid().nullable(),
    causation_id: z.string().max(256).nullable(),
    campaign_id: z.string().max(128).nullable(),
    task_ref: z.string().uuid().nullable(),
    execution_id: z.string().uuid().nullable(),
    execution_binding_id: z.string().uuid().nullable(),
    binding_generation: z.number().int().min(1).nullable(),
    producer: z.string().min(1).max(128),
    observed_at: z.string().min(1),
    idempotency_key: z.string().max(256).nullable(),
    source_ref: z.string().max(512).nullable(),
    plane_identity: z
      .object({
        hub_execution_id: z.string().nullable().optional(),
        control_operation_id: z.string().nullable().optional(),
        paseo_agent_id: z.string().nullable().optional(),
        paseo_server_id: z.string().nullable().optional(),
        sieve_request_id: z.string().nullable().optional(),
        provider_receipt_id: z.string().nullable().optional(),
      })
      .nullable(),
  })
  .passthrough()
  .superRefine((env, ctx) => {
    if ((env.execution_binding_id === null) !== (env.binding_generation === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "binding pair atomicity: execution_binding_id and binding_generation travel together or not at all",
      });
    }
  });

export type CorrelationEnvelopeV2Wire = z.infer<typeof CorrelationEnvelopeV2Schema>;
