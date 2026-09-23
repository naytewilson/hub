/**
 * Boundary tests: Correlation Envelope V1 (wire `anvil.correlation.v2`).
 *
 * These tests prove exact field/version compatibility against the NORMATIVE
 * JSON Schema vendored at ./correlation-envelope-v1.schema.json (byte-identical
 * copy of the frozen contract artifact). The schema is READ from disk and its
 * own const/required/pattern/atomicity rules are enforced — the test follows
 * the contract, not a hardcoded copy of it.
 *
 * Laws under test:
 * - ANVIL/Postgres is the sole minter/advancer of execution_binding_id /
 *   binding_generation. The builder cannot mint/infer/increment (no code path).
 * - Malformed values drop to null, never repaired. Partial binding pairs are
 *   dropped wholesale, never emitted half-formed.
 * - Hub holds no binding_generation: emitted envelopes always carry the pair
 *   as null. Freshness UNKNOWN (evaluated by consumers, never carried).
 * - Namespace split: Hub's agent_executions id travels ONLY as
 *   plane_identity.hub_execution_id, never as execution_id.
 * - No prompt payload: the emitted key set is exactly the 13 canonical keys.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import Ajv2020Module from "ajv/dist/2020.js";
import { z } from "zod";
import type { ControlOperationRecord } from "../db/types.js";
// Draft 2020-12 validator: the normative schema declares
// "$schema": "https://json-schema.org/draft/2020-12/schema". TypeScript
// (NodeNext) cannot see the construct signature through this CJS subpath, and
// the class may arrive as the module itself or under `.default` depending on
// the loader's interop — so the cast is contained here, justified below, and
// runtime-verified by this test file (it compiles and enforces draft
// 2020-12 schemas below; green under vitest proves the class is real).
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- CJS/ESM interop hides the Ajv 2020-12 class type; runtime-verified by the boundary tests in this file.
const Ajv2020 = Ajv2020Module as unknown as new (options?: Record<string, unknown>) => {
  compile(schema: unknown): (data: unknown) => boolean;
};
if (typeof Ajv2020 !== "function") {
  throw new Error("ajv/dist/2020.js did not export the Ajv 2020-12 class");
}
import {
  buildCorrelationEnvelope,
  CORRELATION_ENVELOPE_KEY_ORDER,
  CORRELATION_ENVELOPE_WIRE_SCHEMA,
  CorrelationEnvelopeV2Schema,
  HUB_CONTROL_PRODUCER,
  HUB_PROJECTION_PRODUCER,
  normalizeUuid,
  validateEnvelopeShape,
  type CorrelationEnvelopeV2,
} from "./envelope.js";

const SCHEMA_PATH = new URL("./correlation-envelope-v1.schema.json", import.meta.url);
// The raw schema goes to Ajv unstripped: the zod structural view below drops
// unknown keys (e.g. additionalProperties), which would silently change
// validation semantics. Passed straight through — never asserted on shape.
// oxlint-disable-next-line typescript-eslint/no-unsafe-assignment -- JSON.parse returns any by stdlib design; these bytes are SHA-256-pinned below and flow straight into Ajv with no shape assertion.
const rawNormativeSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
// Structural view of the normative schema for boundary assertions: parsed
// through zod (the repo-idiomatic JSON.parse pattern) rather than a cast,
// so the linter's unsafe-assertion rules stay satisfied. The byte-identity
// of the file itself is pinned separately by the SHA-256 test below.
const NormativeSchemaShape = z.object({
  properties: z
    .object({
      schema: z.object({ const: z.string() }),
      plane_identity: z.object({ properties: z.record(z.string(), z.unknown()) }),
    })
    .catchall(z.unknown()),
  required: z.array(z.string()),
  allOf: z.array(
    z.object({
      anyOf: z.array(
        z.object({
          properties: z.record(z.string(), z.unknown()),
        }),
      ),
    }),
  ),
});
const normativeSchema = NormativeSchemaShape.parse(rawNormativeSchema);

const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const ROOM_ID = "44444444-4444-4444-8444-444444444444";
const OP_ID = "55555555-5555-4555-8555-555555555555";
const HUB_EXECUTION_ID = "66666666-6666-4666-8666-666666666666";

/** Build the canonical Hub projection envelope used across tests. */
function projectionEnvelope(): CorrelationEnvelopeV2 {
  const env = buildCorrelationEnvelope({
    correlation_id: CORRELATION_ID,
    causation_id: "hub:control:grant-1",
    execution_id: EXECUTION_ID,
    binding: null,
    producer: HUB_PROJECTION_PRODUCER,
    observed_at: new Date("2026-09-23T21:42:00.123Z"),
    idempotency_key: "hub:execution.describe:exec-1:seq:7",
    source_ref: "room_events:room-1:7",
    plane_identity: null,
  });
  assert.ok(env !== null);
  return env;
}

// ---------------------------------------------------------------------------
// Compatibility against the normative JSON Schema (read from disk)
// ---------------------------------------------------------------------------

// Frozen contract: sha256 of the normative artifact as verified 2026-09-23.
// The test fails if the vendored copy drifts by even one byte.
const FROZEN_SCHEMA_SHA256 = "95d8e3108ca9c4c38d2c398e0c86cbca0ea6a54cd5b3f9b4f6c2d2188b0ea037";

describe("normative schema compatibility", () => {
  it("vendored schema is byte-identical to the frozen contract artifact", () => {
    const bytes = readFileSync(SCHEMA_PATH);
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest, FROZEN_SCHEMA_SHA256);
  });

  it("wire version matches the schema const exactly", () => {
    assert.equal(CORRELATION_ENVELOPE_WIRE_SCHEMA, normativeSchema.properties.schema.const);
    assert.equal(projectionEnvelope().schema, "anvil.correlation.v2");
  });

  it("emits every required field and nothing outside the canonical key set", () => {
    const env: unknown = projectionEnvelope();
    if (!isRecord(env)) throw new Error("expected an envelope object");
    for (const field of normativeSchema.required) {
      assert.ok(field in env, `missing required field ${field}`);
    }
    const keys = Object.keys(env).sort();
    const canonical = [...CORRELATION_ENVELOPE_KEY_ORDER].sort();
    assert.deepEqual(keys, canonical);
    // No prompt payload can ride the envelope: the key set is closed.
    for (const banned of ["prompt", "messages", "tool_args", "content", "input"]) {
      assert.ok(!(banned in env), `prompt-adjacent key leaked: ${banned}`);
    }
  });

  it("non-null values satisfy every pattern declared by the schema", () => {
    const env: unknown = projectionEnvelope();
    if (!isRecord(env)) throw new Error("expected an envelope object");
    for (const [field, rule] of Object.entries(normativeSchema.properties)) {
      if (!isRecord(rule)) continue;
      const pattern: unknown = rule["pattern"];
      if (typeof pattern !== "string") continue;
      const value: unknown = env[field];
      if (value === null || value === undefined) continue;
      if (typeof value !== "string") {
        throw new Error(`pattern-checked field ${field} is not a string`);
      }
      assert.match(
        value,
        new RegExp(pattern),
        `${field}=${JSON.stringify(value)} violates schema pattern ${pattern}`,
      );
    }
  });

  it("binding-pair atomicity follows the schema allOf/anyOf branches", () => {
    const first = normativeSchema.allOf[0];
    if (!isRecord(first)) throw new Error("schema atomicity branches changed shape");
    const anyOf: unknown = first["anyOf"];
    assert.ok(
      Array.isArray(anyOf) && anyOf.length === 2,
      "schema atomicity branches changed shape",
    );
    const branchMatches = (branch: unknown, env: Record<string, unknown>) => {
      if (!isRecord(branch)) return false;
      const properties: unknown = branch["properties"];
      if (!isRecord(properties)) return false;
      return Object.entries(properties).every(([key, rule]) => {
        const v: unknown = env[key];
        if (!isRecord(rule)) return true;
        if (rule["type"] === "null") return v === null || v === undefined;
        if (rule["type"] === "integer") return typeof v === "number" && Number.isInteger(v);
        if (rule["type"] === "string") return typeof v === "string";
        return true;
      });
    };
    const asRecord = (value: unknown): Record<string, unknown> => {
      if (!isRecord(value)) throw new Error("expected an envelope object");
      return value;
    };
    // Hub never holds generation: the null/null branch must match, always.
    assert.ok(
      anyOf.some((b) => branchMatches(b, asRecord(projectionEnvelope()))),
      "hub envelope violates binding-pair atomicity",
    );
    // A complete pair matches the other branch (proves the rule is read correctly).
    const complete = asRecord({
      ...projectionEnvelope(),
      execution_binding_id: BINDING_ID,
      binding_generation: 3,
    });
    assert.ok(anyOf.some((b) => branchMatches(b, complete)));
    // A partial pair matches NEITHER branch.
    const partial = asRecord({ ...complete, binding_generation: null });
    assert.ok(!anyOf.some((b) => branchMatches(b, partial)));
  });

  it("plane_identity keys are a subset of the schema-defined keys", () => {
    const defined = Object.keys(normativeSchema.properties.plane_identity.properties);
    const env = buildCorrelationEnvelope({
      correlation_id: CORRELATION_ID,
      execution_id: EXECUTION_ID,
      producer: HUB_CONTROL_PRODUCER,
      observed_at: new Date("2026-09-23T21:42:00.123Z"),
      plane_identity: { control_operation_id: OP_ID, hub_execution_id: HUB_EXECUTION_ID },
    });
    assert.ok(env?.plane_identity, "expected plane_identity");
    const planeIdentity: unknown = env.plane_identity;
    if (!isRecord(planeIdentity)) throw new Error("expected plane_identity object");
    for (const key of Object.keys(planeIdentity)) {
      assert.ok(defined.includes(key), `plane_identity key not in contract: ${key}`);
    }
    assert.deepEqual(planeIdentity, {
      control_operation_id: OP_ID,
      hub_execution_id: HUB_EXECUTION_ID,
    });
  });

  it("the zod wire schema accepts the builder output and preserves unknown fields", () => {
    const parsed = CorrelationEnvelopeV2Schema.parse({
      ...projectionEnvelope(),
      future_field: "preserved",
    });
    assert.equal((parsed as Record<string, unknown>)["future_field"], "preserved");
  });

  it("the zod wire schema rejects a partial binding pair", () => {
    const bad = {
      ...projectionEnvelope(),
      execution_binding_id: BINDING_ID,
      binding_generation: null,
    };
    assert.throws(() => CorrelationEnvelopeV2Schema.parse(bad), /binding pair atomicity/);
  });
});

// ---------------------------------------------------------------------------
// Strict JSON Schema validation with a real draft 2020-12 validator (Ajv)
// ---------------------------------------------------------------------------

describe("strict JSON Schema validation (Ajv draft 2020-12)", () => {
  // validateFormats is off: date-time strictness is proven by the Zod layer
  // (CorrelationEnvelopeV2Schema); this block proves the normative schema's
  // own const/pattern/atomicity/additionalProperties rules.
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  const validate = ajv.compile(rawNormativeSchema);

  it("accepts the builder's projection envelope", () => {
    assert.equal(validate(projectionEnvelope()), true);
  });

  it("accepts unknown top-level fields (carriers must preserve them)", () => {
    assert.equal(validate({ ...projectionEnvelope(), future_field: "preserved" }), true);
  });

  it("rejects a wrong schema const", () => {
    assert.equal(validate({ ...projectionEnvelope(), schema: "anvil.correlation.v9" }), false);
  });

  it("rejects malformed uuid fields", () => {
    assert.equal(validate({ ...projectionEnvelope(), correlation_id: "not-a-uuid" }), false);
  });

  it("rejects a partial binding pair (atomicity)", () => {
    assert.equal(
      validate({
        ...projectionEnvelope(),
        execution_binding_id: BINDING_ID,
        binding_generation: null,
      }),
      false,
    );
  });

  it("rejects a non-positive binding generation", () => {
    assert.equal(
      validate({
        ...projectionEnvelope(),
        execution_binding_id: BINDING_ID,
        binding_generation: 0,
      }),
      false,
    );
  });

  it("rejects unknown plane_identity keys (additionalProperties: false)", () => {
    assert.equal(
      validate({
        ...projectionEnvelope(),
        plane_identity: { hub_execution_id: HUB_EXECUTION_ID, made_up_key: "x" },
      }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Builder laws: copy verbatim, shape-check, never mint/infer/repair
// ---------------------------------------------------------------------------

describe("builder laws", () => {
  it("normalizes uuid case, drops malformed uuids to null (never repaired)", () => {
    assert.equal(normalizeUuid(CORRELATION_ID.toUpperCase()), CORRELATION_ID);
    const env = buildCorrelationEnvelope({
      correlation_id: "not-a-uuid",
      execution_id: EXECUTION_ID,
      producer: HUB_PROJECTION_PRODUCER,
      observed_at: new Date("2026-09-23T21:42:00.123Z"),
    });
    assert.equal(env?.correlation_id, null);
    assert.equal(env?.execution_id, EXECUTION_ID);
  });

  it("drops a partial or malformed binding pair wholesale — never half-emitted", () => {
    const partial = buildCorrelationEnvelope({
      correlation_id: CORRELATION_ID,
      execution_id: EXECUTION_ID,
      binding: { execution_binding_id: BINDING_ID, binding_generation: null },
      producer: HUB_PROJECTION_PRODUCER,
      observed_at: new Date("2026-09-23T21:42:00.123Z"),
    });
    assert.equal(partial?.execution_binding_id, null);
    assert.equal(partial?.binding_generation, null);

    for (const badGen of [0, -1, 1.5, "3", true]) {
      const env = buildCorrelationEnvelope({
        correlation_id: CORRELATION_ID,
        execution_id: EXECUTION_ID,
        binding: { execution_binding_id: BINDING_ID, binding_generation: badGen },
        producer: HUB_PROJECTION_PRODUCER,
        observed_at: new Date("2026-09-23T21:42:00.123Z"),
      });
      assert.equal(
        env?.execution_binding_id,
        null,
        `generation ${String(badGen)} must not emit a pair`,
      );
      assert.equal(env?.binding_generation, null);
    }
  });

  it("fails closed (null) without producer/observed_at", () => {
    assert.equal(
      buildCorrelationEnvelope({
        correlation_id: CORRELATION_ID,
        execution_id: EXECUTION_ID,
        producer: "",
        observed_at: new Date(),
      }),
      null,
    );
  });

  it("validateEnvelopeShape mirrors the reference implementation's violations", () => {
    assert.deepEqual(validateEnvelopeShape(projectionEnvelope()), []);
    assert.ok(
      validateEnvelopeShape({ ...projectionEnvelope(), schema: "anvil.correlation.v9" }).some((v) =>
        v.includes("unknown schema"),
      ),
    );
    assert.ok(
      validateEnvelopeShape({ ...projectionEnvelope(), correlation_id: "bogus" }).some((v) =>
        v.includes("malformed uuid field correlation_id"),
      ),
    );
    assert.ok(
      validateEnvelopeShape({
        ...projectionEnvelope(),
        execution_binding_id: BINDING_ID,
        binding_generation: null,
      }).some((v) => v.includes("partial binding identity")),
    );
    assert.ok(
      validateEnvelopeShape({ ...projectionEnvelope(), producer: "" }).some((v) =>
        v.includes("missing producer"),
      ),
    );
  });

  it("emits observed_at as RFC 3339 UTC with fractional seconds", () => {
    assert.equal(projectionEnvelope().observed_at, "2026-09-23T21:42:00.123Z");
  });

  it("canonical key order matches contract §4", () => {
    assert.deepEqual(
      [...CORRELATION_ENVELOPE_KEY_ORDER],
      [
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
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Projection seam: describeExecution carries the envelope
// ---------------------------------------------------------------------------

describe("describeExecution envelope seam", () => {
  it("attaches a verbatim-copy envelope from authority-held values", async () => {
    const { createExecutionConvergence } = await import("../execution-convergence/machine.js");
    const resolved = {
      execution_id: EXECUTION_ID,
      binding_id: BINDING_ID,
      binding_status: "active",
      room_id: ROOM_ID,
      room_internal_id: 7,
      room_status: "active",
      correlation_id: CORRELATION_ID,
      last_transition: {
        state: "running",
        substate: null,
        room_seq: 7,
        event_id: "77777777-7777-4777-8777-777777777777",
        occurred_at: "2026-09-23T21:40:00.000Z",
        causation_id: "hub:control:grant-9",
      },
    } as const;
    const gateway = {
      producer: "test",
      resolveExecution: async () => resolved,
      findTransition: async () => undefined,
      appendTransition: async () => {
        throw new Error("not used");
      },
      mintGrant: async () => {
        throw new Error("not used");
      },
      findGrant: async () => undefined,
    };
    const convergence = createExecutionConvergence({
      gateway,
      database: { findAgentExecutionById: async () => undefined },
      now: () => new Date("2026-09-23T21:42:00.123Z"),
    });
    const description = await convergence.describeExecution(EXECUTION_ID);
    const env = description.correlation;
    assert.equal(env.schema, "anvil.correlation.v2");
    assert.equal(env.correlation_id, CORRELATION_ID);
    assert.equal(env.execution_id, EXECUTION_ID);
    assert.equal(env.causation_id, "hub:control:grant-9");
    // Binding pair: Hub holds binding_id internally but no generation — the
    // pair is NOT emitted half-formed, never inferred.
    assert.equal(env.execution_binding_id, null);
    assert.equal(env.binding_generation, null);
    assert.equal(env.producer, "hub:projection");
    assert.equal(env.observed_at, "2026-09-23T21:42:00.123Z");
    assert.equal(env.idempotency_key, `hub:execution.describe:${EXECUTION_ID}:seq:7`);
    assert.equal(env.source_ref, `room_events:${ROOM_ID}:7`);
    assert.deepEqual(validateEnvelopeShape(env), []);
    // And the zod wire schema accepts it.
    CorrelationEnvelopeV2Schema.parse(env);
  });
});

// ---------------------------------------------------------------------------
// Control seam: toControlOperationWire carries plane-native ids, never maps
// the Hub execution namespace into execution_id
// ---------------------------------------------------------------------------

describe("control operation envelope seam", () => {
  const makeRecord = (overrides: Partial<ControlOperationRecord>): ControlOperationRecord => ({
    id: OP_ID,
    organizationId: "org-1",
    op: "cancel",
    status: "applied",
    idempotencyKey: "test-key-1",
    executionId: HUB_EXECUTION_ID,
    capability: "control.cancel",
    subject: "machine:test",
    correlationId: CORRELATION_ID,
    effect: {},
    response: null,
    createdAt: new Date("2026-09-23T21:42:00.123Z"),
    updatedAt: new Date("2026-09-23T21:42:00.123Z"),
    ...overrides,
  });

  it("keeps the executionId namespaces split", async () => {
    const { toControlOperationWire } = await import("../public-operations/types.js");
    const record = makeRecord({});
    // observed_at is the RESPONSE EMISSION time, never the stored createdAt.
    const emission = new Date("2026-09-24T00:00:00.000Z");
    const wire = toControlOperationWire(record, emission);
    const env = wire.correlation;
    assert.equal(env.schema, "anvil.correlation.v2");
    assert.equal(env.correlation_id, CORRELATION_ID);
    // The Hub agent_executions id NEVER lands in execution_id.
    assert.equal(env.execution_id, null);
    assert.deepEqual(env.plane_identity, {
      control_operation_id: OP_ID,
      hub_execution_id: HUB_EXECUTION_ID,
    });
    assert.equal(env.producer, "hub:control");
    assert.equal(env.observed_at, "2026-09-24T00:00:00.000Z");
    assert.equal(env.idempotency_key, "test-key-1");
    assert.deepEqual(validateEnvelopeShape(env), []);
    CorrelationEnvelopeV2Schema.parse(env);
  });

  it("defaults observed_at to the emission time (not the stored createdAt)", async () => {
    const { toControlOperationWire } = await import("../public-operations/types.js");
    const record = makeRecord({ idempotencyKey: "k2", executionId: null });
    const before = Date.now();
    const wire = toControlOperationWire(record);
    const after = Date.now();
    const observed = Date.parse(wire.correlation.observed_at);
    assert.ok(
      observed >= before && observed <= after,
      `observed_at ${wire.correlation.observed_at} is not the emission time`,
    );
    assert.notEqual(
      wire.correlation.observed_at,
      "2026-09-23T21:42:00.123Z",
      "stale createdAt must never ride the envelope",
    );
    CorrelationEnvelopeV2Schema.parse(wire.correlation);
  });

  it("drops a malformed I1 correlationId passthrough to null (never repaired)", async () => {
    const { toControlOperationWire } = await import("../public-operations/types.js");
    const record = makeRecord({
      idempotencyKey: "k",
      executionId: null,
      correlationId: "not-a-uuid",
    });
    const wire = toControlOperationWire(record);
    assert.equal(wire.correlation.correlation_id, null);
    assert.deepEqual(wire.correlation.plane_identity, { control_operation_id: OP_ID });
    CorrelationEnvelopeV2Schema.parse(wire.correlation);
  });
});
