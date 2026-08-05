import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { BackgroundTaskExecutionTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, eq, getTableColumns, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"

export type State = "running" | "completed" | "error" | "cancelled"

export type Info = {
  sessionID: SessionID
  parentSessionID: SessionID
  generation: string
  ownerID: string
  state: State
  description: string
  parentMessageID: MessageID
  leaseExpiresAt: number
  cancelRequestedAt?: number
  output?: string
  error?: string
  delivery: { messageID: MessageID; partID: PartID }
  deliveryOwnerID?: string
  deliveryLeaseExpiresAt?: number
  terminalDeliveredAt?: number
  wakeRequired: boolean
  wakeOwnerID?: string
  wakeLeaseExpiresAt?: number
  wakeClaimedAt?: number
}

export type ClaimInput = {
  sessionID: SessionID
  parentSessionID: SessionID
  generation: string
  description: string
  parentMessageID: MessageID
  wakeRequired?: boolean
}

export type ClaimResult = {
  status: "claimed" | "owned" | "terminal"
  info: Info
}

export interface Interface {
  readonly ownerID: string
  readonly leaseMillis: number
  readonly claim: (input: ClaimInput) => Effect.Effect<ClaimResult>
  readonly heartbeat: (input: {
    sessionID: SessionID
    generation: string
  }) => Effect.Effect<"owned" | "cancelled" | "lost">
  readonly settle: (input: {
    sessionID: SessionID
    generation: string
    state: Exclude<State, "running">
    output?: string
    error?: string
  }) => Effect.Effect<Info | undefined>
  readonly requestCancel: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly list: (input: { projectID: ProjectV2.ID; directory: string }) => Effect.Effect<Info[]>
  readonly listRunning: (parentSessionID?: SessionID) => Effect.Effect<Info[]>
  readonly pendingTerminals: (sessionID?: SessionID) => Effect.Effect<Info[]>
  readonly claimDelivery: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<Info | undefined>
  readonly completeDelivery: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<boolean>
  readonly requireWake: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<boolean>
  readonly claimWake: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<boolean>
  readonly heartbeatWake: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<"owned" | "lost">
  readonly completeWake: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/BackgroundTaskExecution") {}

export function make(options?: { ownerID?: string; leaseMillis?: number; now?: () => number }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const ownerID = options?.ownerID ?? `${process.pid}:${crypto.randomUUID()}`
    const leaseMillis = options?.leaseMillis ?? 5_000
    const now = options?.now ?? Date.now

    const reconcileExpired = Effect.fn("BackgroundTaskExecution.reconcileExpired")(function* () {
      const time = now()
      const expired = yield* db
        .select({ sessionID: BackgroundTaskExecutionTable.session_id })
        .from(BackgroundTaskExecutionTable)
        .where(
          and(
            eq(BackgroundTaskExecutionTable.state, "running"),
            lte(BackgroundTaskExecutionTable.lease_expires_at, time),
          ),
        )
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (!expired) return
      yield* db
        .update(BackgroundTaskExecutionTable)
        .set({
          state: sql`CASE WHEN ${BackgroundTaskExecutionTable.cancel_requested_at} IS NULL THEN 'error' ELSE 'cancelled' END`,
          error: sql`CASE WHEN ${BackgroundTaskExecutionTable.cancel_requested_at} IS NULL THEN 'Background task owner lease expired' ELSE 'Task cancelled' END`,
          output: null,
          lease_expires_at: time,
          time_updated: time,
        })
        .where(
          and(
            eq(BackgroundTaskExecutionTable.state, "running"),
            lte(BackgroundTaskExecutionTable.lease_expires_at, time),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    })

    const get: Interface["get"] = Effect.fn("BackgroundTaskExecution.get")(function* (sessionID) {
      return fromRow(
        yield* db
          .select()
          .from(BackgroundTaskExecutionTable)
          .where(eq(BackgroundTaskExecutionTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      )
    })

    const listAll = Effect.fn("BackgroundTaskExecution.listAll")(function* () {
      return (yield* db.select().from(BackgroundTaskExecutionTable).all().pipe(Effect.orDie))
        .map(fromRow)
        .filter(isInfo)
    })

    const list: Interface["list"] = Effect.fn("BackgroundTaskExecution.list")(function* (input) {
      yield* reconcileExpired()
      return (yield* db
        .select(getTableColumns(BackgroundTaskExecutionTable))
        .from(BackgroundTaskExecutionTable)
        .innerJoin(SessionTable, eq(BackgroundTaskExecutionTable.session_id, SessionTable.id))
        .where(and(eq(SessionTable.project_id, input.projectID), eq(SessionTable.directory, input.directory)))
        .all()
        .pipe(Effect.orDie))
        .map(fromRow)
        .filter(isInfo)
    })

    const claim: Interface["claim"] = Effect.fn("BackgroundTaskExecution.claim")(function* (input) {
      const time = now()
      const values = {
        session_id: input.sessionID,
        parent_session_id: input.parentSessionID,
        generation: input.generation,
        owner_id: ownerID,
        state: "running" as const,
        description: input.description,
        parent_message_id: input.parentMessageID,
        lease_expires_at: time + leaseMillis,
        delivery: { messageID: MessageID.ascending(), partID: PartID.ascending() },
        wake_required: input.wakeRequired ?? true,
        time_created: time,
        time_updated: time,
      }

      const inserted = yield* db
        .insert(BackgroundTaskExecutionTable)
        .values(values)
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (inserted) return { status: "claimed", info: fromRow(inserted)! }

      yield* reconcileExpired()
      const current = yield* get(input.sessionID)
      if (!current) return yield* claim(input)
      if (current.state === "running") {
        if (current.ownerID === ownerID && current.generation === input.generation) {
          return { status: "claimed", info: current }
        }
        return { status: "owned", info: current }
      }
      if (
        current.generation === input.generation ||
        current.terminalDeliveredAt === undefined ||
        (current.wakeRequired && current.state !== "cancelled" && current.wakeClaimedAt === undefined)
      ) {
        return { status: "terminal", info: current }
      }

      const replaced = yield* db
        .update(BackgroundTaskExecutionTable)
        .set({
          ...values,
          cancel_requested_at: null,
          output: null,
          error: null,
          delivery_owner_id: null,
          delivery_lease_expires_at: null,
          terminal_delivered_at: null,
          wake_owner_id: null,
          wake_lease_expires_at: null,
          wake_claimed_at: null,
        })
        .where(
          and(
            eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
            eq(BackgroundTaskExecutionTable.generation, current.generation),
            eq(BackgroundTaskExecutionTable.state, current.state),
            isNotNull(BackgroundTaskExecutionTable.terminal_delivered_at),
            or(
              eq(BackgroundTaskExecutionTable.wake_required, false),
              eq(BackgroundTaskExecutionTable.state, "cancelled"),
              isNotNull(BackgroundTaskExecutionTable.wake_claimed_at),
            ),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (replaced) return { status: "claimed", info: fromRow(replaced)! }
      return yield* claim(input)
    })

    const heartbeat: Interface["heartbeat"] = Effect.fn("BackgroundTaskExecution.heartbeat")(function* (input) {
      const time = now()
      const renewed = yield* db
        .update(BackgroundTaskExecutionTable)
        .set({ lease_expires_at: time + leaseMillis, time_updated: time })
        .where(
          and(
            eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
            eq(BackgroundTaskExecutionTable.generation, input.generation),
            eq(BackgroundTaskExecutionTable.owner_id, ownerID),
            eq(BackgroundTaskExecutionTable.state, "running"),
            gt(BackgroundTaskExecutionTable.lease_expires_at, time),
            isNull(BackgroundTaskExecutionTable.cancel_requested_at),
          ),
        )
        .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
        .get()
        .pipe(Effect.orDie)
      if (renewed) return "owned"
      const current = yield* get(input.sessionID)
      if (
        current?.generation === input.generation &&
        current.ownerID === ownerID &&
        current.state === "running" &&
        current.cancelRequestedAt !== undefined
      ) {
        return "cancelled"
      }
      return "lost"
    })

    const settle: Interface["settle"] = Effect.fn("BackgroundTaskExecution.settle")(function* (input) {
      const time = now()
      const row = yield* db
        .update(BackgroundTaskExecutionTable)
        .set({
          state: sql`CASE WHEN ${BackgroundTaskExecutionTable.cancel_requested_at} IS NULL THEN ${input.state} ELSE 'cancelled' END`,
          output: sql`CASE WHEN ${BackgroundTaskExecutionTable.cancel_requested_at} IS NULL THEN ${input.output ?? null} ELSE NULL END`,
          error: sql`CASE WHEN ${BackgroundTaskExecutionTable.cancel_requested_at} IS NULL THEN ${input.error ?? null} ELSE 'Task cancelled' END`,
          lease_expires_at: time,
          time_updated: time,
        })
        .where(
          and(
            eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
            eq(BackgroundTaskExecutionTable.generation, input.generation),
            eq(BackgroundTaskExecutionTable.owner_id, ownerID),
            eq(BackgroundTaskExecutionTable.state, "running"),
            gt(BackgroundTaskExecutionTable.lease_expires_at, time),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (row) return fromRow(row)
      yield* reconcileExpired()
      const current = yield* get(input.sessionID)
      if (current?.generation !== input.generation) return undefined
      return current
    })

    const requestCancel: Interface["requestCancel"] = Effect.fn("BackgroundTaskExecution.requestCancel")(
      function* (sessionID) {
        yield* reconcileExpired()
        const rows = yield* listAll()
        const descendants = tree(rows, sessionID)
        const time = now()
        yield* Effect.forEach(
          descendants.filter((row) => row.state === "running"),
          (row) =>
            db
              .update(BackgroundTaskExecutionTable)
              .set({ cancel_requested_at: time, time_updated: time })
              .where(
                and(
                  eq(BackgroundTaskExecutionTable.session_id, row.sessionID),
                  eq(BackgroundTaskExecutionTable.generation, row.generation),
                  eq(BackgroundTaskExecutionTable.state, "running"),
                ),
              )
              .run()
              .pipe(Effect.orDie),
          { concurrency: "unbounded", discard: true },
        )
        return tree(yield* listAll(), sessionID)
      },
    )

    const listRunning: Interface["listRunning"] = Effect.fn("BackgroundTaskExecution.listRunning")(
      function* (parentSessionID) {
        yield* reconcileExpired()
        const conditions = [
          eq(BackgroundTaskExecutionTable.state, "running"),
          gt(BackgroundTaskExecutionTable.lease_expires_at, now()),
        ]
        if (parentSessionID) conditions.push(eq(BackgroundTaskExecutionTable.parent_session_id, parentSessionID))
        return (yield* db
          .select()
          .from(BackgroundTaskExecutionTable)
          .where(and(...conditions))
          .all()
          .pipe(Effect.orDie))
          .map(fromRow)
          .filter(isInfo)
      },
    )

    const pendingTerminals: Interface["pendingTerminals"] = Effect.fn("BackgroundTaskExecution.pendingTerminals")(
      function* (sessionID) {
        yield* reconcileExpired()
        const time = now()
        const rows = (yield* db
          .select()
          .from(BackgroundTaskExecutionTable)
          .where(
            and(
              sql`${BackgroundTaskExecutionTable.state} <> 'running'`,
              eq(BackgroundTaskExecutionTable.wake_required, true),
              or(
                and(
                  isNull(BackgroundTaskExecutionTable.terminal_delivered_at),
                  or(
                    isNull(BackgroundTaskExecutionTable.delivery_owner_id),
                    isNull(BackgroundTaskExecutionTable.delivery_lease_expires_at),
                    lte(BackgroundTaskExecutionTable.delivery_lease_expires_at, time),
                  ),
                ),
                and(
                  isNotNull(BackgroundTaskExecutionTable.terminal_delivered_at),
                  sql`${BackgroundTaskExecutionTable.state} <> 'cancelled'`,
                  isNull(BackgroundTaskExecutionTable.wake_claimed_at),
                  or(
                    isNull(BackgroundTaskExecutionTable.wake_owner_id),
                    isNull(BackgroundTaskExecutionTable.wake_lease_expires_at),
                    lte(BackgroundTaskExecutionTable.wake_lease_expires_at, time),
                  ),
                ),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie))
          .map(fromRow)
          .filter(isInfo)
        if (!sessionID) return rows
        return tree(rows, sessionID)
      },
    )

    const claimDelivery: Interface["claimDelivery"] = Effect.fn("BackgroundTaskExecution.claimDelivery")(
      function* (input) {
        const time = now()
        return fromRow(
          yield* db
            .update(BackgroundTaskExecutionTable)
            .set({
              delivery_owner_id: ownerID,
              delivery_lease_expires_at: time + leaseMillis,
              time_updated: time,
            })
            .where(
              and(
                eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
                eq(BackgroundTaskExecutionTable.generation, input.generation),
                sql`${BackgroundTaskExecutionTable.state} <> 'running'`,
                isNull(BackgroundTaskExecutionTable.terminal_delivered_at),
                or(
                  isNull(BackgroundTaskExecutionTable.delivery_owner_id),
                  isNull(BackgroundTaskExecutionTable.delivery_lease_expires_at),
                  lte(BackgroundTaskExecutionTable.delivery_lease_expires_at, time),
                ),
              ),
            )
            .returning()
            .get()
            .pipe(Effect.orDie),
        )
      },
    )

    const completeDelivery: Interface["completeDelivery"] = Effect.fn("BackgroundTaskExecution.completeDelivery")(
      function* (input) {
        const time = now()
        return Boolean(
          yield* db
            .update(BackgroundTaskExecutionTable)
            .set({ terminal_delivered_at: time, delivery_lease_expires_at: time, time_updated: time })
            .where(
              and(
                eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
                eq(BackgroundTaskExecutionTable.generation, input.generation),
                eq(BackgroundTaskExecutionTable.delivery_owner_id, ownerID),
                isNull(BackgroundTaskExecutionTable.terminal_delivered_at),
              ),
            )
            .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
            .get()
            .pipe(Effect.orDie),
        )
      },
    )

    const claimWake: Interface["claimWake"] = Effect.fn("BackgroundTaskExecution.claimWake")(function* (input) {
      const time = now()
      return Boolean(
        yield* db
          .update(BackgroundTaskExecutionTable)
          .set({ wake_owner_id: ownerID, wake_lease_expires_at: time + leaseMillis, time_updated: time })
          .where(
            and(
              eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
              eq(BackgroundTaskExecutionTable.generation, input.generation),
              sql`${BackgroundTaskExecutionTable.state} <> 'cancelled'`,
              eq(BackgroundTaskExecutionTable.wake_required, true),
              isNotNull(BackgroundTaskExecutionTable.terminal_delivered_at),
              isNull(BackgroundTaskExecutionTable.wake_claimed_at),
              or(
                isNull(BackgroundTaskExecutionTable.wake_owner_id),
                isNull(BackgroundTaskExecutionTable.wake_lease_expires_at),
                lte(BackgroundTaskExecutionTable.wake_lease_expires_at, time),
              ),
            ),
          )
          .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
          .get()
          .pipe(Effect.orDie),
      )
    })

    const requireWake: Interface["requireWake"] = Effect.fn("BackgroundTaskExecution.requireWake")(function* (input) {
      const time = now()
      return Boolean(
        yield* db
          .update(BackgroundTaskExecutionTable)
          .set({ wake_required: true, time_updated: time })
          .where(
            and(
              eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
              eq(BackgroundTaskExecutionTable.generation, input.generation),
              eq(BackgroundTaskExecutionTable.owner_id, ownerID),
              eq(BackgroundTaskExecutionTable.state, "running"),
            ),
          )
          .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
          .get()
          .pipe(Effect.orDie),
      )
    })

    const heartbeatWake: Interface["heartbeatWake"] = Effect.fn("BackgroundTaskExecution.heartbeatWake")(
      function* (input) {
        const time = now()
        const renewed = yield* db
          .update(BackgroundTaskExecutionTable)
          .set({ wake_lease_expires_at: time + leaseMillis, time_updated: time })
          .where(
            and(
              eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
              eq(BackgroundTaskExecutionTable.generation, input.generation),
              eq(BackgroundTaskExecutionTable.wake_owner_id, ownerID),
              isNotNull(BackgroundTaskExecutionTable.terminal_delivered_at),
              isNull(BackgroundTaskExecutionTable.wake_claimed_at),
              gt(BackgroundTaskExecutionTable.wake_lease_expires_at, time),
            ),
          )
          .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
          .get()
          .pipe(Effect.orDie)
        return renewed ? "owned" : "lost"
      },
    )

    const completeWake: Interface["completeWake"] = Effect.fn("BackgroundTaskExecution.completeWake")(
      function* (input) {
        const time = now()
        return Boolean(
          yield* db
            .update(BackgroundTaskExecutionTable)
            .set({ wake_claimed_at: time, wake_lease_expires_at: time, time_updated: time })
            .where(
              and(
                eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
                eq(BackgroundTaskExecutionTable.generation, input.generation),
                eq(BackgroundTaskExecutionTable.wake_owner_id, ownerID),
                isNotNull(BackgroundTaskExecutionTable.terminal_delivered_at),
                isNull(BackgroundTaskExecutionTable.wake_claimed_at),
                gt(BackgroundTaskExecutionTable.wake_lease_expires_at, time),
              ),
            )
            .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
            .get()
            .pipe(Effect.orDie),
        )
      },
    )

    return Service.of({
      ownerID,
      leaseMillis,
      claim,
      heartbeat,
      settle,
      requestCancel,
      get,
      list,
      listRunning,
      pendingTerminals,
      claimDelivery,
      completeDelivery,
      requireWake,
      claimWake,
      heartbeatWake,
      completeWake,
    })
  })
}

function fromRow(row: typeof BackgroundTaskExecutionTable.$inferSelect | undefined): Info | undefined {
  if (!row) return undefined
  return {
    sessionID: row.session_id,
    parentSessionID: row.parent_session_id,
    generation: row.generation,
    ownerID: row.owner_id,
    state: row.state,
    description: row.description,
    parentMessageID: row.parent_message_id,
    leaseExpiresAt: row.lease_expires_at,
    cancelRequestedAt: row.cancel_requested_at ?? undefined,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    delivery: { messageID: MessageID.make(row.delivery.messageID), partID: PartID.make(row.delivery.partID) },
    deliveryOwnerID: row.delivery_owner_id ?? undefined,
    deliveryLeaseExpiresAt: row.delivery_lease_expires_at ?? undefined,
    terminalDeliveredAt: row.terminal_delivered_at ?? undefined,
    wakeRequired: row.wake_required,
    wakeOwnerID: row.wake_owner_id ?? undefined,
    wakeLeaseExpiresAt: row.wake_lease_expires_at ?? undefined,
    wakeClaimedAt: row.wake_claimed_at ?? undefined,
  }
}

function isInfo(info: Info | undefined): info is Info {
  return info !== undefined
}

function tree(rows: Info[], sessionID: SessionID) {
  const found = new Set<SessionID>([sessionID])
  const result: Info[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (found.has(row.sessionID) || found.has(row.parentSessionID)) {
        if (result.some((item) => item.sessionID === row.sessionID)) continue
        found.add(row.sessionID)
        result.push(row)
        changed = true
      }
    }
  }
  return result
}

const layer = Layer.effect(Service, make())

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node] })

export * as BackgroundTaskExecution from "./task-execution"
