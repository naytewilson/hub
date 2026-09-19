/**
 * I4 Hub Control Contract V1 — capability vocabulary (code mirror of
 * `docs/contracts/HUB_CONTROL_CONTRACT_V1.md`, which is the frozen authority).
 *
 * Control capabilities live in `anvil.capability_grants` and are READ by Hub
 * through the read-only Room projection pool — never minted, never written.
 * V1 requires global-scope grants (`scope_kind = 'global'`).
 */

export const CONTROL_CAPABILITIES = {
  resume: "control.resume",
  cancel: "control.cancel",
  retry: "control.retry",
  acknowledge: "control.acknowledge",
  executionStart: "control.execution_start",
} as const;

export type ControlOp = "resume" | "cancel" | "retry" | "acknowledge" | "execution_start";

export const CONTROL_OPS: readonly ControlOp[] = [
  "resume",
  "cancel",
  "retry",
  "acknowledge",
  "execution_start",
] as const;

export function controlCapabilityFor(op: ControlOp): string {
  switch (op) {
    case "resume":
      return CONTROL_CAPABILITIES.resume;
    case "cancel":
      return CONTROL_CAPABILITIES.cancel;
    case "retry":
      return CONTROL_CAPABILITIES.retry;
    case "acknowledge":
      return CONTROL_CAPABILITIES.acknowledge;
    case "execution_start":
      return CONTROL_CAPABILITIES.executionStart;
    default:
      throw new Error(`Unknown control op: ${String(op)}`);
  }
}

/** The bound ANVIL subject holds no durable grant for the control capability. */
export class ControlCapabilityDeniedError extends Error {
  constructor(
    public readonly capability: string,
    public readonly subject: string,
  ) {
    super(`control capability denied: ${capability} for ${subject}`);
    this.name = "ControlCapabilityDeniedError";
  }
}
