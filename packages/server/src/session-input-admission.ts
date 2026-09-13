import { SessionV2 } from "@opencode-ai/core/session"
import { Context, Effect, Layer } from "effect"

export type Input = Parameters<SessionV2.Interface["prompt"]>[0]

export interface Interface {
  readonly prompt: SessionV2.Interface["prompt"]
  /** Snapshots active work using the execution owner selected by this host. */
  readonly active: Effect.Effect<ReadonlySet<SessionV2.ID>>
  /** Interrupts work using the execution owner selected by this host. */
  readonly interrupt: (sessionID: SessionV2.ID) => Effect.Effect<void>
}

/**
 * Lets a host preserve the public durable-session API while choosing its
 * execution owner. The default delegates to the V2 runner; the V1 host
 * replaces Queue admission and the associated active/interrupt hooks.
 */
export class Service extends Context.Service<Service, Interface>()("@opencode/ServerSessionInputAdmission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return Service.of({ prompt: session.prompt, active: session.active, interrupt: session.interrupt })
  }),
)

export * as SessionInputAdmission from "./session-input-admission"
