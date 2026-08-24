import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { BackgroundTaskExecution } from "@/background/task-execution"
import { Effect, Exit, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionRunLease } from "./run-lease"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly interrupt: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly wake: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly requestWake: (sessionID: SessionID) => Effect.Effect<number>
  readonly scheduleWake: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<void>
  readonly awaitWake: (sessionID: SessionID) => Effect.Effect<void>
  readonly resumeWake: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts | undefined>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const executions = yield* BackgroundTaskExecution.Service
    const status = yield* SessionStatus.Service
    const leases = yield* SessionRunLease.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        const statusWatchers = new Set<SessionID>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            statusWatchers.clear()
          }),
        )
        return { runners, scope, statusWatchers }
      }),
    )

    const settleStatus = Effect.fn("SessionRunState.settleStatus")(function* (
      sessionID: SessionID,
      data: {
        runners: Map<SessionID, Runner.Runner<SessionV1.WithParts>>
        scope: Scope.Scope
        statusWatchers: Set<SessionID>
      },
    ) {
      if (data.statusWatchers.has(sessionID)) return
      data.statusWatchers.add(sessionID)
      yield* Scope.provide(data.scope)(
        Effect.gen(function* () {
          while (yield* leases.isBusy(sessionID)) yield* Effect.sleep("25 millis")
          if (!data.runners.get(sessionID)?.busy) yield* status.set(sessionID, { type: "idle" })
        }).pipe(
          Effect.ensuring(Effect.sync(() => data.statusWatchers.delete(sessionID))),
          Effect.forkScoped({ startImmediately: true }),
        ),
      )
    })

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          if (yield* leases.isBusy(sessionID)) {
            yield* settleStatus(sessionID, data)
            return
          }
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy || (yield* leases.isBusy(sessionID))) yield* busyError(sessionID)
    })

    const interrupt = Effect.fn("SessionRunState.interrupt")(function* (sessionID: SessionID) {
      yield* leases.requestCancel(sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing) {
        if (!(yield* leases.isBusy(sessionID))) yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
      if (yield* leases.isBusy(sessionID)) {
        yield* settleStatus(sessionID, data)
        return
      }
      yield* status.set(sessionID, { type: "idle" })
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const descendants = yield* executions.requestCancel(sessionID)
      yield* cancelBackgroundJobs(background, sessionID)
      yield* Effect.forEach(new Set([sessionID, ...descendants.map((execution) => execution.sessionID)]), interrupt, {
        concurrency: "unbounded",
        discard: true,
      })
    })

    const heartbeat = Effect.fn("SessionRunState.heartbeat")(function* (
      sessionID: SessionID,
      token: string,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const watch = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Math.max(25, Math.min(250, Math.floor(leases.leaseMillis / 3))))
          if ((yield* leases.heartbeat(sessionID, token)) !== "owned") return yield* Effect.interrupt
        }
      })
      return yield* Effect.raceFirst(work, watch).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? leases.release(sessionID, token).pipe(Effect.asVoid) : Effect.void,
        ),
      )
    })

    const drain = Effect.fn("SessionRunState.drain")(function* (
      sessionID: SessionID,
      revision: number,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      let result: SessionV1.WithParts | undefined
      let targetRevision = revision
      while (true) {
        const current = yield* leases.get(sessionID)
        if (current && current.wakeCompleted >= targetRevision) return result ?? (yield* onInterrupt)
        const outcome = yield* Effect.scoped(
          Effect.gen(function* () {
            const claim = yield* leases.claimScoped(sessionID)
            if (!claim) return { type: "unavailable" as const }
            const value = yield* heartbeat(sessionID, claim.token, work)
            if (!(yield* leases.complete(sessionID, claim.token, claim.targetRevision))) {
              return { type: "interrupted" as const }
            }
            return { type: "completed" as const, value }
          }),
        )
        if (outcome.type === "unavailable") {
          yield* Effect.sleep("25 millis")
          continue
        }
        if (outcome.type === "interrupted") return yield* onInterrupt
        result = outcome.value
        const completed = yield* leases.get(sessionID)
        if (!completed || completed.wakeCompleted >= completed.wakeRequested) return result
        targetRevision = completed.wakeRequested
      }
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const revision = yield* leases.requestWake(sessionID)
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(drain(sessionID, revision, onInterrupt, work))
    })

    const requestWake: Interface["requestWake"] = Effect.fn("SessionRunState.requestWake")((sessionID) =>
      leases.requestWake(sessionID),
    )

    const wakeAt = Effect.fn("SessionRunState.wakeAt")(function* (
      sessionID: SessionID,
      revision: number,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).wake(drain(sessionID, revision, onInterrupt, work))
    })

    const wake = Effect.fn("SessionRunState.wake")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      return yield* wakeAt(sessionID, yield* leases.requestWake(sessionID), onInterrupt, work)
    })

    const scheduleWake: Interface["scheduleWake"] = Effect.fn("SessionRunState.scheduleWake")(
      function* (sessionID, onInterrupt, work) {
        const current = yield* leases.get(sessionID)
        if (!current || current.wakeCompleted >= current.wakeRequested) return
        const data = yield* InstanceState.get(state)
        yield* wakeAt(sessionID, current.wakeRequested, onInterrupt, work).pipe(
          Effect.catchCause((cause) => Effect.logWarning("failed to drain queued session wake", { sessionID, cause })),
          Effect.forkIn(data.scope, { startImmediately: true }),
        )
      },
    )

    const awaitWake: Interface["awaitWake"] = Effect.fn("SessionRunState.awaitWake")(function* (sessionID) {
      const revision = (yield* leases.get(sessionID))?.wakeRequested
      if (revision === undefined) return
      while (true) {
        const current = yield* leases.get(sessionID)
        if (!current || current.wakeCompleted >= revision) return
        yield* Effect.sleep("25 millis")
      }
    })

    const resumeWake: Interface["resumeWake"] = Effect.fn("SessionRunState.resumeWake")(
      function* (sessionID, onInterrupt, work) {
        const current = yield* leases.get(sessionID)
        if (!current || current.wakeCompleted >= current.wakeRequested) return
        return yield* wakeAt(sessionID, current.wakeRequested, onInterrupt, work)
      },
    )

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const claim = yield* leases.claimExclusiveScoped(sessionID)
          if (!claim) return yield* busyError(sessionID)
          return yield* (yield* runner(sessionID, onInterrupt))
            .startShell(heartbeat(sessionID, claim.token, work), ready)
            .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
        }),
      )
    })

    return Service.of({
      assertNotBusy,
      cancel,
      interrupt,
      ensureRunning,
      wake,
      requestWake,
      scheduleWake,
      awaitWake,
      resumeWake,
      startShell,
    })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [BackgroundJob.node, BackgroundTaskExecution.node, SessionStatus.node, SessionRunLease.node],
})

export * as SessionRunState from "./run-state"
