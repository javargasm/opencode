import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { durableQueueParts, SessionPrompt } from "@/session/prompt"
import { SessionRunLease } from "@/session/run-lease"
import { MessageID } from "@/session/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { SessionInputTable, SessionRunLeaseTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionV2 } from "@opencode-ai/core/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionInputAdmission } from "@opencode-ai/server/session-input-admission"
import { and, eq, gt } from "drizzle-orm"
import { Effect, Layer, Scope, Context } from "effect"

export interface Interface {
  /** Starts or joins the V1 runner that owns this session's durable Queue. */
  readonly schedule: (sessionID: SessionV2.ID) => Effect.Effect<void>
  /** Snapshots V1 work owned by this process, including durable Queue drains. */
  readonly active: Effect.Effect<ReadonlySet<SessionV2.ID>>
  /** Interrupts a V1 runner inside the persisted session's instance context. */
  readonly interrupt: (sessionID: SessionV2.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/V1DurableQueue") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const events = yield* EventV2Bridge.Service
    const leases = yield* SessionRunLease.Service
    const scope = yield* Scope.Scope
    const drains = KeyedMutex.makeUnsafe<SessionV2.ID>()

    const sessionContext = Effect.fn("V1DurableQueue.sessionContext")(function* (sessionID: SessionV2.ID) {
      const session = yield* db
        .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session) return
      return {
        instance: yield* instances.load({ directory: session.directory }),
        workspaceID: session.workspaceID ?? undefined,
      }
    })

    const heartbeat = <A, E, R>(sessionID: SessionV2.ID, token: string, work: Effect.Effect<A, E, R>) =>
      Effect.raceFirst(
        work,
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Math.max(25, Math.min(250, Math.floor(leases.leaseMillis / 3))))
            if ((yield* leases.heartbeat(sessionID, token)) !== "owned") return yield* Effect.interrupt
          }
        }),
      )

    const drain = Effect.fn("V1DurableQueue.drain")(function* (sessionID: SessionV2.ID) {
      const context = yield* sessionContext(sessionID)
      if (!context) return
      const inSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(InstanceRef, context.instance),
          Effect.provideService(WorkspaceRef, context.workspaceID),
        )

      while (true) {
        const wake = yield* leases.get(sessionID)
        if (yield* leases.isBusy(sessionID)) {
          yield* Effect.sleep("25 millis")
          continue
        }
        if (wake && wake.wakeCompleted < wake.wakeRequested) {
          // A previous materialization already committed a durable wake. Resume
          // it before looking at later Queue entries, including after restart.
          yield* inSession(prompt.loop({ sessionID }))
          continue
        }

        const outcome = yield* inSession(
          Effect.scoped(
            Effect.gen(function* () {
              // Claim before resolving files/plugins so two V1 processes cannot
              // materialize the same durable input outside the event transaction.
              // The claim is released before `prompt.loop` claims its wake.
              const claim = yield* leases.claimExclusiveScoped(sessionID)
              if (!claim) return { type: "unavailable" as const }

              const queued = yield* SessionInput.nextQueued(db, sessionID)
              if (!queued) return { type: "empty" as const }

              return {
                type: "processed" as const,
                consumed: yield* heartbeat(
                  sessionID,
                  claim.token,
                  Effect.gen(function* () {
                    const materialized = yield* prompt.materializeLegacy({
                      messageID: MessageID.make(queued.id),
                      sessionID,
                      noReply: true,
                      parts: durableQueueParts(queued.prompt),
                    })
                    if (materialized.info.role !== "user")
                      return yield* Effect.die(new Error("Durable Queue materialization must produce a user message"))

                    return yield* SessionInput.consumeLegacy(db, events, {
                      sessionID,
                      id: queued.id,
                      info: materialized.info,
                      parts: materialized.parts,
                      delivery: "queue",
                      // The wake commits in the same transaction as the legacy
                      // materialization, so a crash cannot strand a promoted Queue row.
                      commit: () => SessionRunLease.requestWake(db, sessionID).pipe(Effect.asVoid),
                    })
                  }),
                ),
              }
            }),
          ),
        )
        if (outcome.type === "unavailable") {
          yield* Effect.sleep("25 millis")
          continue
        }
        if (outcome.type === "empty") return
      }
    })

    const schedule: Interface["schedule"] = Effect.fn("V1DurableQueue.schedule")(function* (sessionID) {
      yield* drains
        .withLock(sessionID)(drain(sessionID))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("failed to drain V1 durable Queue", {
              sessionID,
              cause,
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
    })

    const active: Interface["active"] = leases.active.pipe(
      Effect.map((sessionIDs) => new Set([...sessionIDs].map((sessionID) => SessionV2.ID.make(sessionID)))),
    )

    const interrupt: Interface["interrupt"] = Effect.fn("V1DurableQueue.interrupt")(function* (sessionID) {
      const context = yield* sessionContext(sessionID)
      if (!context) return
      yield* prompt.cancel(sessionID).pipe(
        Effect.provideService(InstanceRef, context.instance),
        Effect.provideService(WorkspaceRef, context.workspaceID),
      )
    })

    const recover = Effect.fn("V1DurableQueue.recover")(function* () {
      const [pending, wakes] = yield* Effect.all([
        SessionInput.pendingQueueSessions(db),
        db
          .select({ sessionID: SessionRunLeaseTable.session_id })
          .from(SessionRunLeaseTable)
          .innerJoin(SessionInputTable, eq(SessionInputTable.session_id, SessionRunLeaseTable.session_id))
          .where(
            and(
              eq(SessionInputTable.delivery, "queue"),
              gt(SessionRunLeaseTable.wake_requested_seq, SessionRunLeaseTable.wake_completed_seq),
            ),
          )
          .all()
          .pipe(Effect.orDie),
      ])
      const sessions = new Set<SessionV2.ID>([
        ...pending.map((sessionID) => SessionV2.ID.make(sessionID)),
        ...wakes.map((wake) => SessionV2.ID.make(wake.sessionID)),
      ])
      yield* Effect.forEach(sessions, schedule, { discard: true })
    })

    // Restart recovery runs independently of the admission feature flag: a
    // rollback stops advertising new Queue work but must not strand rows that
    // were already accepted durably.
    // Recovery only scans durable state and schedules drains, so complete the
    // scan before exposing the layer. The drains themselves remain async.
    yield* recover().pipe(Effect.catchCause((cause) => Effect.logError("failed to recover V1 durable Queue", { cause })))

    return Service.of({ schedule, active, interrupt })
  }),
)

export const admissionLayer = Layer.effect(
  SessionInputAdmission.Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const queue = yield* Service
    const session = yield* SessionV2.Service

    const prompt: SessionInputAdmission.Interface["prompt"] = Effect.fn("V1DurableQueue.admit")(function* (input) {
      if (input.delivery !== "queue" || !flags.v1DurableSessionInput) return yield* session.prompt(input)

      // Never let V2 SessionExecution race the V1 runner. Queue admission is
      // durable first, then this host schedules its V1 materializer.
      const admitted = yield* session.prompt({ ...input, resume: false })
      if (admitted.promotedSeq === undefined) yield* queue.schedule(admitted.sessionID)
      return admitted
    })

    const active: SessionInputAdmission.Interface["active"] = flags.v1DurableSessionInput ? queue.active : session.active
    const interrupt: SessionInputAdmission.Interface["interrupt"] = (sessionID) =>
      flags.v1DurableSessionInput ? queue.interrupt(sessionID) : session.interrupt(sessionID)

    return SessionInputAdmission.Service.of({ prompt, active, interrupt })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, EventV2Bridge.node, InstanceStore.node, SessionPrompt.node, SessionRunLease.node],
})

export * as V1DurableQueue from "./durable-queue"
