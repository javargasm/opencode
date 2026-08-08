import { expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunLeaseTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Context, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { eq } from "drizzle-orm"
import { createServer } from "net"
import path from "path"
import { ProcessIncarnation } from "@/session/process-incarnation"
import { SessionRunLease } from "@/session/run-lease"
import { SessionID } from "@/session/schema"
import { tmpdir } from "../fixture/fixture"

test("fences an expired session drain across independent SQLite connections", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "session-run-lease.sqlite")

  await run(
    Effect.gen(function* () {
      const firstDatabase = Context.get(
        yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
        Database.Service,
      )
      const secondDatabase = Context.get(
        yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
        Database.Service,
      )
      const sessionID = yield* seed().pipe(Effect.provideService(Database.Service, firstDatabase))
      let now = 1_000
      const first = yield* SessionRunLease.make({ leaseMillis: 100, now: () => now, processID: 101 }).pipe(
        Effect.provideService(Database.Service, firstDatabase),
      )
      const second = yield* SessionRunLease.make({
        leaseMillis: 100,
        now: () => now,
        processID: 202,
        isProcessAlive: () => false,
      }).pipe(Effect.provideService(Database.Service, secondDatabase))

      yield* first.requestWake(sessionID)
      const original = yield* first.claim(sessionID)
      if (!original) throw new Error("first connection did not claim the drain")
      expect(yield* first.heartbeat(sessionID, original.token)).toBe("owned")
      expect(yield* second.claim(sessionID)).toBeUndefined()

      now = 1_101
      const successor = yield* second.claim(sessionID)
      if (!successor) throw new Error("second connection did not take over the expired drain")
      expect(successor.token).not.toBe(original.token)
      expect(yield* first.complete(sessionID, original.token, original.targetRevision)).toBe(false)
      expect(yield* first.release(sessionID, original.token)).toBe(false)
      expect(yield* second.complete(sessionID, successor.token, successor.targetRevision)).toBe(true)
      expect(yield* second.get(sessionID)).toMatchObject({ wakeRequested: 1, wakeCompleted: 1 })
    }),
  )
})

test("does not take over an expired lease while its recorded process is alive", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "session-live-owner.sqlite")

  await run(
    Effect.gen(function* () {
      const firstDatabase = Context.get(
        yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
        Database.Service,
      )
      const secondDatabase = Context.get(
        yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
        Database.Service,
      )
      const sessionID = yield* seed().pipe(Effect.provideService(Database.Service, firstDatabase))
      let now = 1_000
      const owner = yield* SessionRunLease.make({ leaseMillis: 100, now: () => now, processID: 101 }).pipe(
        Effect.provideService(Database.Service, firstDatabase),
      )
      const contender = yield* SessionRunLease.make({
        leaseMillis: 100,
        now: () => now,
        processID: 202,
        isProcessAlive: (processID) => processID === 101,
      }).pipe(Effect.provideService(Database.Service, secondDatabase))

      yield* owner.requestWake(sessionID)
      const original = yield* owner.claim(sessionID)
      if (!original) throw new Error("owner did not claim the drain")
      now = 1_101

      expect(yield* contender.claim(sessionID)).toBeUndefined()
      expect(yield* owner.release(sessionID, original.token)).toBe(true)
    }),
  )
})

test("releases a scoped exclusive claim when its fiber is interrupted", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "session-scoped-claim.sqlite")

  await run(
    Effect.gen(function* () {
      const database = Context.get(yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))), Database.Service)
      const sessionID = yield* seed().pipe(Effect.provideService(Database.Service, database))
      const leases = yield* SessionRunLease.make().pipe(Effect.provideService(Database.Service, database))
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const claim = yield* leases.claimExclusiveScoped(sessionID)
          if (!claim) throw new Error("exclusive claim was not acquired")
          yield* Effect.never
        }),
      ).pipe(Effect.forkChild)

      yield* Effect.sleep("25 millis")
      expect(yield* leases.isBusy(sessionID)).toBe(true)
      yield* Fiber.interrupt(fiber)
      expect(yield* leases.isBusy(sessionID)).toBe(false)
    }),
  )
})

test("treats cancellation of an unknown session as a no-op", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "session-unknown-cancel.sqlite")

  await run(
    Effect.gen(function* () {
      const database = Context.get(yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))), Database.Service)
      const leases = yield* SessionRunLease.make().pipe(Effect.provideService(Database.Service, database))
      const sessionID = SessionID.create()

      expect(Exit.isSuccess(yield* leases.requestCancel(sessionID).pipe(Effect.exit))).toBe(true)
      expect(yield* leases.get(sessionID)).toBeUndefined()
    }),
  )
})

test("coalesces wakes before a claim and exposes at most one successor batch", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "session-wake-batch.sqlite")

  await run(
    Effect.gen(function* () {
      const firstDatabase = Context.get(
        yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
        Database.Service,
      )
      const secondDatabase = Context.get(
        yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
        Database.Service,
      )
      const sessionID = yield* seed().pipe(Effect.provideService(Database.Service, firstDatabase))
      const first = yield* SessionRunLease.make().pipe(Effect.provideService(Database.Service, firstDatabase))
      const second = yield* SessionRunLease.make().pipe(Effect.provideService(Database.Service, secondDatabase))

      expect(yield* first.requestWake(sessionID)).toBe(1)
      expect(yield* second.requestWake(sessionID)).toBe(2)
      const current = yield* first.claim(sessionID)
      if (!current) throw new Error("current batch was not claimed")
      expect(current.targetRevision).toBe(2)

      expect(yield* second.requestWake(sessionID)).toBe(3)
      expect(yield* first.requestWake(sessionID)).toBe(4)
      expect(yield* first.complete(sessionID, current.token, current.targetRevision)).toBe(true)

      const successor = yield* second.claim(sessionID)
      if (!successor) throw new Error("successor batch was not claimed")
      expect(successor.targetRevision).toBe(4)
      expect(yield* first.claim(sessionID)).toBeUndefined()
      expect(yield* second.complete(sessionID, successor.token, successor.targetRevision)).toBe(true)
      expect(yield* first.claim(sessionID)).toBeUndefined()
    }),
  )
})

test("makes a remote session cancellation observable to its drain owner", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "session-remote-cancel.sqlite")

  await run(
    Effect.gen(function* () {
      const firstDatabase = Context.get(
        yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
        Database.Service,
      )
      const secondDatabase = Context.get(
        yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
        Database.Service,
      )
      const sessionID = yield* seed().pipe(Effect.provideService(Database.Service, firstDatabase))
      const owner = yield* SessionRunLease.make().pipe(Effect.provideService(Database.Service, firstDatabase))
      const remote = yield* SessionRunLease.make().pipe(Effect.provideService(Database.Service, secondDatabase))

      yield* owner.requestWake(sessionID)
      const claim = yield* owner.claim(sessionID)
      if (!claim) throw new Error("session drain was not claimed")
      yield* remote.requestCancel(sessionID)
      expect(yield* remote.requestWake(sessionID)).toBe(2)

      expect(yield* owner.heartbeat(sessionID, claim.token)).toBe("cancelled")
      expect(yield* owner.complete(sessionID, claim.token, claim.targetRevision)).toBe(false)
      expect(yield* remote.isBusy(sessionID)).toBe(true)
      expect(yield* owner.release(sessionID, claim.token)).toBe(true)
      expect(yield* remote.isBusy(sessionID)).toBe(false)
      const successor = yield* remote.claim(sessionID)
      if (!successor) throw new Error("post-cancel wake was not preserved")
      expect(successor.targetRevision).toBe(2)
      expect(yield* remote.complete(sessionID, successor.token, successor.targetRevision)).toBe(true)
    }),
  )
})

test("matching process incarnation blocks expired takeover", async () => {
  await using tmp = await tmpdir()

  await run(
    Effect.gen(function* () {
      const current = yield* ProcessIncarnation.Service
      const state = yield* claimed(path.join(tmp.path, "matching-incarnation.sqlite"))

      expect(yield* current.probe({ incarnationID: current.incarnationID, port: current.port })).toBe("alive")
      state.clock.value = 1_101
      expect(yield* state.contender.claim(state.sessionID)).toBeUndefined()
      expect(yield* state.owner.release(state.sessionID, state.original.token)).toBe(true)
    }),
  )
})

test("legacy lease without incarnation remains conservatively PID-only", async () => {
  await using tmp = await tmpdir()

  await run(
    Effect.gen(function* () {
      const state = yield* claimed(path.join(tmp.path, "legacy-incarnation.sqlite"))
      yield* setIncarnation(state.sessionID, null, null).pipe(Effect.provideService(Database.Service, state.database))

      state.clock.value = 1_101
      expect(yield* state.contender.claim(state.sessionID)).toBeUndefined()
      expect(yield* state.owner.release(state.sessionID, state.original.token)).toBe(true)
    }),
  )
})

test("closed process incarnation permits PID-reuse takeover and fences the stale token", async () => {
  await using tmp = await tmpdir()
  const incarnationID = crypto.randomUUID()
  const witness = await openWitness(incarnationID)
  const port = witness.port
  await witness.close()

  await run(
    Effect.gen(function* () {
      const current = yield* ProcessIncarnation.Service
      const state = yield* claimed(path.join(tmp.path, "closed-incarnation.sqlite"))
      yield* setIncarnation(state.sessionID, incarnationID, port).pipe(
        Effect.provideService(Database.Service, state.database),
      )

      expect(yield* current.probe({ incarnationID, port })).toBe("ended")
      state.clock.value = 1_101
      const successor = yield* state.contender.claim(state.sessionID)
      if (!successor) throw new Error("closed incarnation was not taken over")
      expect(yield* state.owner.release(state.sessionID, state.original.token)).toBe(false)
      expect(yield* state.owner.complete(state.sessionID, state.original.token, state.original.targetRevision)).toBe(
        false,
      )
      expect(yield* state.contender.release(state.sessionID, successor.token)).toBe(true)
    }),
  )
})

test("different valid process incarnation permits PID-reuse takeover", async () => {
  await using tmp = await tmpdir()
  await using witness = await openWitness(crypto.randomUUID())
  const previous = crypto.randomUUID()

  await run(
    Effect.gen(function* () {
      const current = yield* ProcessIncarnation.Service
      const state = yield* claimed(path.join(tmp.path, "different-incarnation.sqlite"))
      yield* setIncarnation(state.sessionID, previous, witness.port).pipe(
        Effect.provideService(Database.Service, state.database),
      )

      expect(yield* current.probe({ incarnationID: previous, port: witness.port })).toBe("ended")
      state.clock.value = 1_101
      const successor = yield* state.contender.claim(state.sessionID)
      if (!successor) throw new Error("different incarnation was not taken over")
      expect(yield* state.contender.release(state.sessionID, successor.token)).toBe(true)
    }),
  )
})

test("timeout and invalid process-incarnation responses deny takeover", async () => {
  await using tmp = await tmpdir()
  await using timeout = await openWitness()
  await using invalid = await openWitness("not-an-incarnation")

  await run(
    Effect.gen(function* () {
      const current = yield* ProcessIncarnation.Service
      const timedOut = yield* claimed(path.join(tmp.path, "timeout-incarnation.sqlite"))
      yield* setIncarnation(timedOut.sessionID, crypto.randomUUID(), timeout.port).pipe(
        Effect.provideService(Database.Service, timedOut.database),
      )
      timedOut.clock.value = 1_101
      expect(yield* current.probe({ incarnationID: crypto.randomUUID(), port: timeout.port })).toBe("unknown")
      expect(yield* timedOut.contender.claim(timedOut.sessionID)).toBeUndefined()

      const malformed = yield* claimed(path.join(tmp.path, "invalid-incarnation.sqlite"))
      yield* setIncarnation(malformed.sessionID, crypto.randomUUID(), invalid.port).pipe(
        Effect.provideService(Database.Service, malformed.database),
      )
      malformed.clock.value = 1_101
      expect(yield* current.probe({ incarnationID: crypto.randomUUID(), port: invalid.port })).toBe("unknown")
      expect(yield* malformed.contender.claim(malformed.sessionID)).toBeUndefined()
    }),
  )
})

function run(effect: Effect.Effect<void, unknown, ProcessIncarnation.Service | Scope.Scope>) {
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(ProcessIncarnation.layer))))
}

function claimed(filename: string) {
  return Effect.gen(function* () {
    const database = Context.get(yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))), Database.Service)
    const contenderDatabase = Context.get(
      yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
      Database.Service,
    )
    const sessionID = yield* seed().pipe(Effect.provideService(Database.Service, database))
    const clock = { value: 1_000 }
    const owner = yield* SessionRunLease.make({ leaseMillis: 100, now: () => clock.value, processID: 101 }).pipe(
      Effect.provideService(Database.Service, database),
    )
    const contender = yield* SessionRunLease.make({
      leaseMillis: 100,
      now: () => clock.value,
      processID: 202,
      isProcessAlive: (processID) => processID === 101,
    }).pipe(Effect.provideService(Database.Service, contenderDatabase))

    yield* owner.requestWake(sessionID)
    const original = yield* owner.claim(sessionID)
    if (!original) throw new Error("owner did not claim the drain")
    return { database, sessionID, clock, owner, contender, original }
  })
}

function setIncarnation(sessionID: SessionID, incarnationID: string | null, port: number | null) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionRunLeaseTable)
      .set({ owner_incarnation_id: incarnationID, owner_incarnation_port: port })
      .where(eq(SessionRunLeaseTable.session_id, sessionID))
      .run()
  })
}

async function openWitness(response?: string) {
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy())
    if (response !== undefined) socket.end(response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("witness did not bind a TCP port")
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return { port: address.port, close, [Symbol.asyncDispose]: close }
}

function seed() {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const projectID = ProjectV2.ID.make(`project-${crypto.randomUUID()}`)
    const sessionID = SessionID.create()
    const time = Date.now()
    yield* db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: AbsolutePath.make("/tmp/project"),
        sandboxes: [],
        time_created: time,
        time_updated: time,
      })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: sessionID,
        directory: "/tmp/project",
        title: sessionID,
        version: "test",
        time_created: time,
        time_updated: time,
      })
      .run()
    return sessionID
  })
}
