import { describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Context, Effect, Fiber, Latch, Layer, Logger } from "effect"
import { BackgroundTaskExecution } from "@/background/task-execution"
import { MessageID, SessionID } from "@/session/schema"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Database.node))

describe("BackgroundTaskExecution", () => {
  it.live("allows only one runtime to own a session generation", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      let now = 1_000
      const first = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a", now: () => now })
      const second = yield* BackgroundTaskExecution.make({ ownerID: "runtime-b", now: () => now })

      const claims = yield* Effect.all(
        [first.claim(claim(ids, "generation-1")), second.claim(claim(ids, "generation-1"))],
        { concurrency: "unbounded" },
      )

      expect(claims.map((result) => result.status).toSorted()).toEqual(["claimed", "owned"])
      expect(new Set(claims.map((result) => result.info.ownerID)).size).toBe(1)
    }),
  )

  it.live("lists durable executions for a parent after settlement", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a" })
      yield* owner.claim(claim(ids, "generation-1"))
      yield* owner.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "durable result",
      })

      expect(yield* owner.listForParent(ids.parent)).toEqual([
        expect.objectContaining({
          sessionID: ids.child,
          generation: "generation-1",
          state: "completed",
          output: "durable result",
        }),
      ])
    }),
  )

  it.live("makes a remote cancellation request observable to the owner", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      let now = 1_000
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a", now: () => now })
      const remote = yield* BackgroundTaskExecution.make({ ownerID: "runtime-b", now: () => now })
      yield* owner.claim(claim(ids, "generation-1"))

      yield* remote.requestCancel(ids.child)

      expect(yield* owner.heartbeat({ sessionID: ids.child, generation: "generation-1" })).toBe("cancelled")
    }),
  )

  it.live("allows one durable follow-up per active background generation", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a" })
      const remote = yield* BackgroundTaskExecution.make({ ownerID: "runtime-b" })
      yield* owner.claim({ ...claim(ids, "generation-1"), parentVariant: "xhigh" })

      expect(yield* owner.claimFollowup({ sessionID: ids.child, generation: "generation-1" })).toBe("claimed")
      expect(yield* remote.claimFollowup({ sessionID: ids.child, generation: "generation-1" })).toBe("already_claimed")
      expect(yield* owner.get(ids.child)).toMatchObject({
        parentVariant: "xhigh",
        followupClaimedAt: expect.any(Number),
      })

      yield* owner.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "done",
      })
      expect(yield* owner.claimFollowup({ sessionID: ids.child, generation: "generation-1" })).toBe("inactive")
      const delivery = yield* owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* owner.completeDelivery({
        sessionID: ids.child,
        generation: "generation-1",
        token: delivery.token,
      })
      expect(yield* owner.claim(claim(ids, "generation-2"))).toMatchObject({ status: "claimed" })
      expect(yield* owner.claimFollowup({ sessionID: ids.child, generation: "generation-2" })).toBe("claimed")
    }),
  )

  it.live("reconciles an expired lease when the former owner tries to settle", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      let now = 1_000
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a", leaseMillis: 100, now: () => now })
      yield* owner.claim(claim(ids, "generation-1"))
      now = 1_101

      expect(
        yield* owner.settle({
          sessionID: ids.child,
          generation: "generation-1",
          state: "completed",
          output: "late result",
        }),
      ).toMatchObject({ generation: "generation-1", state: "error" })
    }),
  )

  it.live("logs lease acquisition, renewal, loss, and expiration", () => {
    const logs: Array<{ level: string; message: unknown }> = []
    const logger = Logger.make((options) => {
      logs.push({ level: options.logLevel, message: options.message })
    })
    return Effect.gen(function* () {
      const ids = yield* seed()
      let now = 1_000
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a", leaseMillis: 100, now: () => now })

      yield* owner.claim(claim(ids, "generation-1"))
      now = 1_010
      expect(yield* owner.heartbeat({ sessionID: ids.child, generation: "generation-1" })).toBe("owned")
      now = 1_111
      expect(yield* owner.heartbeat({ sessionID: ids.child, generation: "generation-1" })).toBe("lost")
      expect(
        yield* owner.settle({
          sessionID: ids.child,
          generation: "generation-1",
          state: "completed",
          output: "late result",
        }),
      ).toMatchObject({ state: "error" })

      expect(logs).toContainEqual({
        level: "Info",
        message: [
          "background task lease acquired",
          expect.objectContaining({
            sessionID: ids.child,
            parentSessionID: ids.parent,
            generation: "generation-1",
            ownerID: "runtime-a",
            acquiredAt: 1_000,
            leaseExpiresAt: 1_100,
            leaseMillis: 100,
          }),
        ],
      })
      expect(logs).toContainEqual({
        level: "Info",
        message: [
          "background task lease renewed",
          expect.objectContaining({
            sessionID: ids.child,
            generation: "generation-1",
            ownerID: "runtime-a",
            renewedAt: 1_010,
            leaseExpiresAt: 1_110,
            leaseMillis: 100,
          }),
        ],
      })
      expect(logs).toContainEqual({
        level: "Warn",
        message: [
          "background task lease heartbeat failed",
          expect.objectContaining({
            sessionID: ids.child,
            generation: "generation-1",
            ownerID: "runtime-a",
            failedAt: 1_111,
            reason: "lease_expired",
            leaseExpiresAt: 1_110,
            leaseRemainingMillis: -1,
          }),
        ],
      })
      expect(logs).toContainEqual({
        level: "Warn",
        message: [
          "background task lease reconciled as expired",
          expect.objectContaining({
            sessionID: ids.child,
            parentSessionID: ids.parent,
            generation: "generation-1",
            ownerID: "runtime-a",
            expiredAt: 1_111,
            leaseExpiresAt: 1_110,
            executionAgeMillis: 111,
            reason: "owner_lease_expired",
          }),
        ],
      })
    }).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live("keeps an expired owner's terminal local and rejects a late prior-generation terminal", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      let now = 1_000
      const first = yield* BackgroundTaskExecution.make({
        ownerID: "runtime-a",
        leaseMillis: 100,
        now: () => now,
      })
      const second = yield* BackgroundTaskExecution.make({
        ownerID: "runtime-b",
        leaseMillis: 100,
        now: () => now,
      })
      yield* first.claim({ ...claim(ids, "generation-1"), wakeRequired: true })
      now = 1_101

      expect(yield* second.pendingTerminals(ids.parent)).toEqual([])
      expect(yield* first.pendingTerminals(ids.parent)).toEqual([
        expect.objectContaining({ generation: "generation-1", state: "error" }),
      ])

      const delivery = yield* first.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* first.completeDelivery({
        sessionID: ids.child,
        generation: "generation-1",
        token: delivery.token,
      })
      const wake = yield* first.claimWake({ sessionID: ids.child, generation: "generation-1" })
      if (!wake) throw new Error("terminal wake was not claimed")
      expect(
        yield* first.completeWake({
          sessionID: ids.child,
          generation: "generation-1",
          token: wake.token,
        }),
      ).toBe(true)

      const next = yield* second.claim(claim(ids, "generation-2"))
      expect(next.status).toBe("claimed")
      expect(
        yield* first.settle({
          sessionID: ids.child,
          generation: "generation-1",
          state: "completed",
          output: "late result",
        }),
      ).toBeUndefined()
      expect(yield* second.get(ids.child)).toMatchObject({ generation: "generation-2", state: "running" })
    }),
  )

  it.live("allows only one terminal delivery claim from the same runtime", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a" })
      yield* owner.claim(claim(ids, "generation-1"))
      yield* owner.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "done",
      })

      const claims = yield* Effect.all(
        [
          owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" }),
          owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(claims.filter((result) => result !== undefined)).toHaveLength(1)
    }),
  )

  it.live("fences an expired delivery claim from a stale same-runtime attempt", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      let now = 1_000
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a", leaseMillis: 100, now: () => now })
      yield* owner.claim(claim(ids, "generation-1"))
      yield* owner.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "done",
      })

      const stale = yield* owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!stale) throw new Error("initial delivery was not claimed")
      now = 1_101
      const replacement = yield* owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!replacement) throw new Error("expired delivery was not reclaimed")

      expect(replacement.token).not.toBe(stale.token)
      expect(
        yield* owner.completeDelivery({
          sessionID: ids.child,
          generation: "generation-1",
          token: stale.token,
        }),
      ).toBe(false)
      expect(yield* owner.get(ids.child)).toMatchObject({
        deliveryOwnerID: replacement.token,
        terminalDeliveredAt: undefined,
      })
      expect(
        yield* owner.completeDelivery({
          sessionID: ids.child,
          generation: "generation-1",
          token: replacement.token,
        }),
      ).toBe(true)
    }),
  )

  it.live("recovers an undelivered foreground terminal without scheduling a parent wake", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a" })
      yield* owner.claim({ ...claim(ids, "generation-1"), wakeRequired: false })
      yield* owner.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "done",
      })

      expect(yield* owner.pendingTerminals(ids.parent)).toEqual([
        expect.objectContaining({
          sessionID: ids.child,
          wakeRequired: false,
          terminalDeliveredAt: undefined,
        }),
      ])
      const delivery = yield* owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* owner.completeDelivery({
        sessionID: ids.child,
        generation: "generation-1",
        token: delivery.token,
      })

      expect(yield* owner.pendingTerminals(ids.parent)).toEqual([])
      expect(yield* owner.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBeUndefined()
    }),
  )

  it.live("waits for the required parent wake before relaunch", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      const first = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a" })
      const second = yield* BackgroundTaskExecution.make({ ownerID: "runtime-b" })
      yield* first.claim({
        ...claim(ids, "generation-1"),
        wakeRequired: true,
      })
      yield* first.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "done",
      })
      const delivery = yield* first.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* first.completeDelivery({
        sessionID: ids.child,
        generation: "generation-1",
        token: delivery.token,
      })
      const wake = yield* first.claimWake({ sessionID: ids.child, generation: "generation-1" })
      if (!wake) throw new Error("terminal wake was not claimed")

      expect(yield* second.claim(claim(ids, "generation-2"))).toMatchObject({
        status: "terminal",
        info: { generation: "generation-1" },
      })

      expect(yield* first.completeWake({ sessionID: ids.child, generation: "generation-1", token: wake.token })).toBe(
        true,
      )
      expect(yield* second.claim(claim(ids, "generation-2"))).toMatchObject({
        status: "claimed",
        info: { generation: "generation-2" },
      })
    }),
  )

  it.live("replaces an active terminal wake only after observing its delivered message", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      const first = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a" })
      const second = yield* BackgroundTaskExecution.make({ ownerID: "runtime-b" })
      yield* first.claim({ ...claim(ids, "generation-1"), wakeRequired: true })
      const terminal = yield* first.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "done",
      })
      if (!terminal) throw new Error("terminal execution missing")
      const delivery = yield* first.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* first.completeDelivery({
        sessionID: ids.child,
        generation: "generation-1",
        token: delivery.token,
      })
      const wake = yield* first.claimWake({ sessionID: ids.child, generation: "generation-1" })
      if (!wake) throw new Error("terminal wake was not claimed")

      expect(
        yield* second.claimAfterObservedTerminal({
          ...claim(ids, "generation-2"),
          wakeRequired: true,
          observedDeliveryMessageID: MessageID.ascending(),
        }),
      ).toMatchObject({ status: "terminal", info: { generation: "generation-1" } })
      expect(
        yield* second.claimAfterObservedTerminal({
          ...claim(ids, "generation-2"),
          wakeRequired: true,
          observedDeliveryMessageID: terminal.delivery.messageID,
        }),
      ).toMatchObject({ status: "claimed", info: { generation: "generation-2", state: "running" } })
      expect(yield* first.completeWake({ sessionID: ids.child, generation: "generation-1", token: wake.token })).toBe(
        false,
      )
    }),
  )

  it.live("renews an in-flight wake lease and rejects its stale former owner", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      let now = 1_000
      const first = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a", leaseMillis: 100, now: () => now })
      const second = yield* BackgroundTaskExecution.make({ ownerID: "runtime-b", leaseMillis: 100, now: () => now })
      yield* first.claim({ ...claim(ids, "generation-1"), wakeRequired: true })
      yield* first.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "done",
      })
      const delivery = yield* first.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* first.completeDelivery({
        sessionID: ids.child,
        generation: "generation-1",
        token: delivery.token,
      })
      const wake = yield* first.claimWake({ sessionID: ids.child, generation: "generation-1" })
      if (!wake) throw new Error("terminal wake was not claimed")

      now = 1_050
      expect(yield* first.heartbeatWake({ sessionID: ids.child, generation: "generation-1", token: wake.token })).toBe(
        "owned",
      )
      now = 1_101
      expect(yield* second.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBeUndefined()
      now = 1_151
      const replacement = yield* second.claimWake({ sessionID: ids.child, generation: "generation-1" })
      if (!replacement) throw new Error("expired wake was not reclaimed")
      expect(yield* first.completeWake({ sessionID: ids.child, generation: "generation-1", token: wake.token })).toBe(
        false,
      )
      expect(
        yield* second.completeWake({
          sessionID: ids.child,
          generation: "generation-1",
          token: replacement.token,
        }),
      ).toBe(true)
    }),
  )

  it.live("fences an expired wake claim from a stale same-runtime attempt", () =>
    Effect.gen(function* () {
      const ids = yield* seed()
      let now = 1_000
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a", leaseMillis: 100, now: () => now })
      yield* owner.claim({ ...claim(ids, "generation-1"), wakeRequired: true })
      yield* owner.settle({
        sessionID: ids.child,
        generation: "generation-1",
        state: "completed",
        output: "done",
      })
      const delivery = yield* owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* owner.completeDelivery({
        sessionID: ids.child,
        generation: "generation-1",
        token: delivery.token,
      })
      const stale = yield* owner.claimWake({ sessionID: ids.child, generation: "generation-1" })
      if (!stale) throw new Error("initial wake was not claimed")
      now = 1_101
      const replacement = yield* owner.claimWake({ sessionID: ids.child, generation: "generation-1" })
      if (!replacement) throw new Error("expired wake was not reclaimed")

      expect(replacement.token).not.toBe(stale.token)
      expect(yield* owner.heartbeatWake({ sessionID: ids.child, generation: "generation-1", token: stale.token })).toBe(
        "lost",
      )
      expect(yield* owner.completeWake({ sessionID: ids.child, generation: "generation-1", token: stale.token })).toBe(
        false,
      )
      expect(yield* owner.get(ids.child)).toMatchObject({
        wakeOwnerID: replacement.token,
        wakeClaimedAt: undefined,
      })
      expect(
        yield* owner.heartbeatWake({
          sessionID: ids.child,
          generation: "generation-1",
          token: replacement.token,
        }),
      ).toBe("owned")
      expect(
        yield* owner.completeWake({
          sessionID: ids.child,
          generation: "generation-1",
          token: replacement.token,
        }),
      ).toBe(true)
    }),
  )

  it.live("persists root cancellation for every descendant execution", () =>
    Effect.gen(function* () {
      const ids = yield* seed(true)
      let now = 1_000
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "runtime-a", now: () => now })
      const remote = yield* BackgroundTaskExecution.make({ ownerID: "runtime-b", now: () => now })
      yield* owner.claim(claim(ids, "generation-child"))
      yield* owner.claim({
        ...claim({ parent: ids.child, child: ids.grandchild! }, "generation-grandchild"),
        description: "grandchild",
      })

      yield* remote.requestCancel(ids.parent)

      expect(yield* owner.heartbeat({ sessionID: ids.child, generation: "generation-child" })).toBe("cancelled")
      expect(yield* owner.heartbeat({ sessionID: ids.grandchild!, generation: "generation-grandchild" })).toBe(
        "cancelled",
      )
    }),
  )
})

test("coordinates recovery through independent SQLite connections", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "background-task.sqlite")

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const firstDatabase = Context.get(
          yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
          Database.Service,
        )
        const secondDatabase = Context.get(
          yield* Layer.build(Layer.fresh(Database.layerFromPath(filename))),
          Database.Service,
        )
        const ids = yield* seed().pipe(Effect.provideService(Database.Service, firstDatabase))
        let now = 1_000
        const first = yield* BackgroundTaskExecution.make({
          ownerID: "connection-a",
          leaseMillis: 100,
          now: () => now,
        }).pipe(Effect.provideService(Database.Service, firstDatabase))
        const second = yield* BackgroundTaskExecution.make({
          ownerID: "connection-b",
          leaseMillis: 100,
          now: () => now,
        }).pipe(Effect.provideService(Database.Service, secondDatabase))

        const barrier = yield* Latch.make()
        const firstClaim = yield* barrier.await.pipe(
          Effect.andThen(first.claim(claim(ids, "generation-1"))),
          Effect.forkScoped,
        )
        const secondClaim = yield* barrier.await.pipe(
          Effect.andThen(second.claim(claim(ids, "generation-1"))),
          Effect.forkScoped,
        )
        yield* barrier.open
        const claims = yield* Effect.all([Fiber.join(firstClaim), Fiber.join(secondClaim)], {
          concurrency: "unbounded",
        })
        expect(claims.map((result) => result.status).toSorted()).toEqual(["claimed", "owned"])

        const owner = claims[0]?.status === "claimed" ? first : second
        const remote = owner === first ? second : first
        yield* remote.requestCancel(ids.child)
        expect(yield* owner.heartbeat({ sessionID: ids.child, generation: "generation-1" })).toBe("cancelled")
        expect(
          yield* owner.settle({
            sessionID: ids.child,
            generation: "generation-1",
            state: "completed",
            output: "cancel raced with completion",
          }),
        ).toMatchObject({ state: "cancelled" })
        const cancelledDelivery = yield* remote.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
        if (!cancelledDelivery) throw new Error("cancelled terminal delivery was not claimed")
        yield* remote.completeDelivery({
          sessionID: ids.child,
          generation: "generation-1",
          token: cancelledDelivery.token,
        })

        expect(
          yield* remote.claim({
            ...claim(ids, "generation-2"),
            wakeRequired: true,
          }),
        ).toMatchObject({ status: "claimed" })
        now = 1_101
        expect(yield* remote.pendingTerminals(ids.parent)).toEqual([
          expect.objectContaining({ generation: "generation-2", state: "error" }),
        ])

        const delivery = yield* remote.claimDelivery({ sessionID: ids.child, generation: "generation-2" })
        if (!delivery) throw new Error("terminal delivery was not claimed")
        yield* remote.completeDelivery({
          sessionID: ids.child,
          generation: "generation-2",
          token: delivery.token,
        })
        const wake = yield* remote.claimWake({ sessionID: ids.child, generation: "generation-2" })
        if (!wake) throw new Error("terminal wake was not claimed")
        expect(yield* second.claimWake({ sessionID: ids.child, generation: "generation-2" })).toBeUndefined()
        now = 1_202
        const replacement = yield* second.claimWake({ sessionID: ids.child, generation: "generation-2" })
        if (!replacement) throw new Error("expired wake was not reclaimed")
        expect(
          yield* second.completeWake({
            sessionID: ids.child,
            generation: "generation-2",
            token: replacement.token,
          }),
        ).toBe(true)
        expect(yield* first.claimWake({ sessionID: ids.child, generation: "generation-2" })).toBeUndefined()

        expect(yield* second.claim(claim(ids, "generation-3"))).toMatchObject({
          status: "claimed",
          info: { generation: "generation-3", state: "running" },
        })
      }),
    ),
  )
})

function claim(ids: { parent: SessionID; child: SessionID }, generation: string) {
  return {
    sessionID: ids.child,
    parentSessionID: ids.parent,
    generation,
    description: "child task",
    parentMessageID: MessageID.ascending(),
    wakeRequired: false,
  }
}

function seed(grandchild = false) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const project = ProjectV2.ID.make(`project-${crypto.randomUUID()}`)
    const parent = SessionID.create()
    const child = SessionID.create()
    const nested = grandchild ? SessionID.create() : undefined
    const time = Date.now()
    yield* db
      .insert(ProjectTable)
      .values({
        id: project,
        worktree: AbsolutePath.make("/tmp/project"),
        sandboxes: [],
        time_created: time,
        time_updated: time,
      })
      .run()
    yield* db
      .insert(SessionTable)
      .values([
        session(parent, project, undefined, time),
        session(child, project, parent, time),
        ...(nested ? [session(nested, project, child, time)] : []),
      ])
      .run()
    return { parent, child, grandchild: nested }
  })
}

function session(id: SessionID, projectID: ProjectV2.ID, parentID: SessionID | undefined, time: number) {
  return {
    id,
    project_id: projectID,
    parent_id: parentID,
    slug: id,
    directory: "/tmp/project",
    title: id,
    version: "test",
    time_created: time,
    time_updated: time,
  }
}
