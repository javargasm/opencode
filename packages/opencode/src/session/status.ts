import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { BackgroundTaskExecution } from "@/background/task-execution"
import { SessionRunLease } from "./run-lease"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const executions = yield* BackgroundTaskExecution.Service
    const leases = yield* SessionRunLease.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const current = data.get(sessionID)
      if (yield* leases.isBusy(sessionID)) return current ?? { type: "busy" as const }
      const execution = yield* executions.get(sessionID)
      if (execution && (execution.state !== "running" || execution.cancelRequestedAt !== undefined)) {
        return { type: "idle" as const }
      }
      if (current) return current
      return execution ? { type: "busy" as const } : { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      const result = new Map(yield* InstanceState.get(state))
      const ctx = yield* InstanceState.context
      for (const execution of yield* executions.list({ projectID: ctx.project.id, directory: ctx.directory })) {
        if (execution.state !== "running" || execution.cancelRequestedAt !== undefined) {
          result.delete(execution.sessionID)
          continue
        }
        if (!result.has(execution.sessionID)) result.set(execution.sessionID, { type: "busy" })
      }
      for (const lease of yield* leases.list({ projectID: ctx.project.id, directory: ctx.directory })) {
        if (!result.has(lease.sessionID)) result.set(lease.sessionID, { type: "busy" })
      }
      return result
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      yield* events.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        return
      }
      data.set(sessionID, status)
    })

    return Service.of({ get, list, set })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, BackgroundTaskExecution.node, SessionRunLease.node],
})

export * as SessionStatus from "./status"
