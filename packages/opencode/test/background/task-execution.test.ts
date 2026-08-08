import { describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Context, Effect, Fiber, Latch, Layer } from "effect"
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
      yield* owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      yield* owner.completeDelivery({ sessionID: ids.child, generation: "generation-1" })
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

  it.live("reconciles an expired owner once and rejects a late prior-generation terminal", () =>
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

      const pending = yield* second.pendingTerminals(ids.parent)
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ generation: "generation-1", state: "error" })

      const deliveryClaims = yield* Effect.all(
        [
          first.claimDelivery({ sessionID: ids.child, generation: "generation-1" }),
          second.claimDelivery({ sessionID: ids.child, generation: "generation-1" }),
        ],
        { concurrency: "unbounded" },
      )
      expect(deliveryClaims.filter(Boolean)).toHaveLength(1)
      const deliveryOwner = deliveryClaims[0] ? first : second
      yield* deliveryOwner.completeDelivery({ sessionID: ids.child, generation: "generation-1" })
      expect(yield* deliveryOwner.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBe(true)
      expect(yield* deliveryOwner.completeWake({ sessionID: ids.child, generation: "generation-1" })).toBe(true)

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
      yield* owner.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      yield* owner.completeDelivery({ sessionID: ids.child, generation: "generation-1" })

      expect(yield* owner.pendingTerminals(ids.parent)).toEqual([])
      expect(yield* owner.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBe(false)
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
      yield* first.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      yield* first.completeDelivery({ sessionID: ids.child, generation: "generation-1" })
      expect(yield* first.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBe(true)

      expect(yield* second.claim(claim(ids, "generation-2"))).toMatchObject({
        status: "terminal",
        info: { generation: "generation-1" },
      })

      expect(yield* first.completeWake({ sessionID: ids.child, generation: "generation-1" })).toBe(true)
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
      yield* first.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      yield* first.completeDelivery({ sessionID: ids.child, generation: "generation-1" })
      expect(yield* first.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBe(true)

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
      expect(yield* first.completeWake({ sessionID: ids.child, generation: "generation-1" })).toBe(false)
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
      yield* first.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
      yield* first.completeDelivery({ sessionID: ids.child, generation: "generation-1" })
      expect(yield* first.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBe(true)

      now = 1_050
      expect(yield* first.heartbeatWake({ sessionID: ids.child, generation: "generation-1" })).toBe("owned")
      now = 1_101
      expect(yield* second.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBe(false)
      now = 1_151
      expect(yield* second.claimWake({ sessionID: ids.child, generation: "generation-1" })).toBe(true)
      expect(yield* first.completeWake({ sessionID: ids.child, generation: "generation-1" })).toBe(false)
      expect(yield* second.completeWake({ sessionID: ids.child, generation: "generation-1" })).toBe(true)
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
        yield* remote.claimDelivery({ sessionID: ids.child, generation: "generation-1" })
        yield* remote.completeDelivery({ sessionID: ids.child, generation: "generation-1" })

        expect(
          yield* remote.claim({
            ...claim(ids, "generation-2"),
            wakeRequired: true,
          }),
        ).toMatchObject({ status: "claimed" })
        now = 1_101
        expect(yield* owner.pendingTerminals(ids.parent)).toEqual([
          expect.objectContaining({ generation: "generation-2", state: "error" }),
        ])

        yield* owner.claimDelivery({ sessionID: ids.child, generation: "generation-2" })
        yield* owner.completeDelivery({ sessionID: ids.child, generation: "generation-2" })
        expect(yield* owner.claimWake({ sessionID: ids.child, generation: "generation-2" })).toBe(true)
        expect(yield* second.claimWake({ sessionID: ids.child, generation: "generation-2" })).toBe(false)
        now = 1_202
        expect(yield* second.claimWake({ sessionID: ids.child, generation: "generation-2" })).toBe(true)
        expect(yield* second.completeWake({ sessionID: ids.child, generation: "generation-2" })).toBe(true)
        expect(yield* first.claimWake({ sessionID: ids.child, generation: "generation-2" })).toBe(false)

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
