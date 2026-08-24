import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Database.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )

  it.instance("relays a materialized legacy prompt to live legacy listeners", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const session = yield* SessionNs.Service
      const info = yield* session.create({})
      const messageID = MessageID.ascending()
      const inputID = SessionMessage.ID.make(messageID)
      const partID = PartID.ascending()
      yield* SessionInput.admit(db, events, {
        id: inputID,
        sessionID: info.id,
        prompt: Prompt.make({ text: "Show this follow-up live" }),
        delivery: "legacy",
      })

      const seen: string[] = []
      const off = yield* events.listen((event) => {
        seen.push(event.type)
        return Effect.void
      })
      const global: GlobalEvent[] = []
      const listener = (event: GlobalEvent) => global.push(event)
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          GlobalBus.off("event", listener)
        }),
      )

      yield* SessionInput.consumeLegacy(db, events, {
        id: inputID,
        sessionID: info.id,
        info: {
          id: messageID,
          role: "user",
          sessionID: info.id,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        },
        parts: [
          {
            id: partID,
            messageID,
            sessionID: info.id,
            type: "text",
            text: "Show this follow-up live",
          },
        ],
      })
      const visible: string[] = [
        SessionV1.Event.LegacyPromptMaterialized.type,
        SessionV1.Event.MessageUpdated.type,
        SessionV1.Event.PartUpdated.type,
      ]
      expect(seen.filter((type) => visible.includes(type))).toEqual(visible)
      expect(global.map((event) => event.payload.type).filter((type) => visible.includes(type))).toEqual(visible)

      const replay = yield* session.create({})
      yield* events.remove(replay.id)
      const replayMessageID = MessageID.ascending()
      const replayInputID = SessionMessage.ID.make(replayMessageID)
      const replayPartID = PartID.ascending()
      yield* SessionInput.admit(db, events, {
        id: replayInputID,
        sessionID: replay.id,
        prompt: Prompt.make({ text: "Replay this follow-up live" }),
        delivery: "legacy",
      })
      const replaySeq = (yield* EventV2.latestSequence(db, replay.id)) + 1
      const definition = SessionV1.Event.LegacyPromptMaterialized
      if (!definition.durable) return yield* Effect.die("legacy materialization event must be durable")
      seen.length = 0
      global.length = 0
      yield* events.replay(
        {
          id: EventV2.ID.create(),
          type: EventV2.versionedType(
            definition.type,
            definition.durable.version,
          ),
          aggregateID: replay.id,
          seq: replaySeq,
          data: {
            sessionID: replay.id,
            inputID: replayMessageID,
            info: {
              id: replayMessageID,
              role: "user",
              sessionID: replay.id,
              time: { created: Date.now() },
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            },
            parts: [
              {
                id: replayPartID,
                messageID: replayMessageID,
                sessionID: replay.id,
                type: "text",
                text: "Replay this follow-up live",
              },
            ],
          },
        },
        { publish: true },
      )
      expect(yield* EventV2.latestSequence(db, replay.id)).toBe(replaySeq)
      expect(seen.filter((type) => visible.includes(type))).toEqual(visible)
      expect(global.map((event) => event.payload.type).filter((type) => visible.includes(type))).toEqual(visible)
      yield* off
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("forks the chronological prefix across mixed message ID ordering", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const ids = ["msg_z9-before", "msg_z1-before-wrap", "msg_a0-after-wrap", "msg_a1-after"]
      for (const [index, id] of ids.entries()) {
        yield* session.updateMessage({
          id: MessageID.make(id),
          sessionID: created.id,
          role: "user",
          time: { created: index + 1 },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
      }

      const beforeWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[1]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const afterWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[2]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      expect((yield* session.messages({ sessionID: beforeWrap.id })).map((msg) => msg.info.time.created)).toEqual([1])
      expect((yield* session.messages({ sessionID: afterWrap.id })).map((msg) => msg.info.time.created)).toEqual([1, 2])
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
