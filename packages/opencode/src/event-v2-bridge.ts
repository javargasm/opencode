// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Context, Effect, Layer, Schema } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@opencode/EventV2Bridge") {}

const isLegacyPromptMaterialized = Schema.is(SessionV1.Event.LegacyPromptMaterialized)

function liveEvents(event: EventV2.Payload): ReadonlyArray<EventV2.Payload> {
  if (!isLegacyPromptMaterialized(event)) return [event]
  const location = event.location ? { location: event.location } : {}
  return [
    event,
    {
      id: EventV2.ID.create(),
      type: SessionV1.Event.MessageUpdated.type,
      ...location,
      data: { sessionID: event.data.sessionID, info: event.data.info },
    },
    ...event.data.parts.map((part) => ({
      id: EventV2.ID.create(),
      type: SessionV1.Event.PartUpdated.type,
      ...location,
      data: { sessionID: event.data.sessionID, part, time: event.data.info.time.created },
    })),
  ]
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* events.publish(definition, data, options)
        const ctx = yield* InstanceRef
        if (!ctx) return yield* events.publish(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* events.publish(definition, data, {
          ...options,
          location: new Location.Info({
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        for (const live of liveEvents(event)) {
          GlobalBus.emit("event", {
            directory: live.location?.directory ?? ctx?.directory,
            project: ctx?.project.id,
            workspace: workspaceID,
            payload: { id: live.id, type: live.type, properties: live.data },
          })
          if (live.durable === undefined) continue
          GlobalBus.emit("event", {
            directory: live.location?.directory ?? ctx?.directory,
            project: ctx?.project.id,
            workspace: workspaceID,
            payload: {
              type: "sync",
              syncEvent: {
                id: live.id,
                type: EventV2.versionedType(live.type, live.durable.version),
                seq: live.durable.seq,
                aggregateID: live.durable.aggregateID,
                data: live.data,
              },
            },
          })
        }
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    const listen: EventV2.Interface["listen"] = (listener) =>
      events.listen((event) => Effect.forEach(liveEvents(event), listener, { discard: true }))

    return Service.of({ ...events, publish, listen })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node] })

export * as EventV2Bridge from "./event-v2-bridge"
