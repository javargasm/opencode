import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { BackgroundTaskExecutionTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, eq, getTableColumns, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionRunLease } from "@/session/run-lease"

export type State = "running" | "completed" | "error" | "cancelled"

export type Info = {
  sessionID: SessionID
  parentSessionID: SessionID
  generation: string
  ownerID: string
  state: State
  description: string
  parentMessageID: MessageID
  parentVariant?: string
  leaseExpiresAt: number
  followupClaimedAt?: number
  followupMessageID?: MessageID
  followupHash?: string
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
  parentVariant?: string
  wakeRequired?: boolean
}

export type ClaimResult = {
  status: "claimed" | "owned" | "terminal"
  info: Info
}

export type FollowupClaim = "claimed" | "replayed" | "conflict" | "already_claimed" | "inactive"

export type LeaseClaim = {
  token: string
}

export interface Interface {
  readonly ownerID: string
  readonly leaseMillis: number
  readonly claim: (input: ClaimInput) => Effect.Effect<ClaimResult>
  readonly claimAfterObservedTerminal: (
    input: ClaimInput & { observedDeliveryMessageID: MessageID },
  ) => Effect.Effect<ClaimResult>
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
  readonly claimFollowup: (input: {
    sessionID: SessionID
    parentSessionID: SessionID
    generation: string
    messageID: MessageID
    hash: string
  }) => Effect.Effect<FollowupClaim>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly list: (input: { projectID: ProjectV2.ID; directory: string }) => Effect.Effect<Info[]>
  readonly listForParent: (parentSessionID: SessionID) => Effect.Effect<Info[]>
  readonly listPendingHandoffs: (parentSessionID: SessionID) => Effect.Effect<Info[]>
  readonly listRunning: (parentSessionID?: SessionID) => Effect.Effect<Info[]>
  readonly pendingTerminals: (sessionID?: SessionID) => Effect.Effect<Info[]>
  readonly claimDelivery: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<LeaseClaim | undefined>
  readonly heartbeatDelivery: (input: {
    sessionID: SessionID
    generation: string
    token: string
  }) => Effect.Effect<"owned" | "lost">
  readonly completeDelivery: (input: {
    sessionID: SessionID
    generation: string
    token: string
  }) => Effect.Effect<boolean>
  readonly requireWake: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<boolean>
  readonly claimWake: (input: { sessionID: SessionID; generation: string }) => Effect.Effect<LeaseClaim | undefined>
  readonly heartbeatWake: (input: {
    sessionID: SessionID
    generation: string
    token: string
  }) => Effect.Effect<"owned" | "lost">
  readonly completeWake: (input: { sessionID: SessionID; generation: string; token: string }) => Effect.Effect<boolean>
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
        .select({
          sessionID: BackgroundTaskExecutionTable.session_id,
          parentSessionID: BackgroundTaskExecutionTable.parent_session_id,
          generation: BackgroundTaskExecutionTable.generation,
          ownerID: BackgroundTaskExecutionTable.owner_id,
          leaseExpiresAt: BackgroundTaskExecutionTable.lease_expires_at,
          timeCreated: BackgroundTaskExecutionTable.time_created,
        })
        .from(BackgroundTaskExecutionTable)
        .where(
          and(
            eq(BackgroundTaskExecutionTable.state, "running"),
            lte(BackgroundTaskExecutionTable.lease_expires_at, time),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      if (expired.length === 0) return
      const reconciled = yield* db
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
        .returning({
          sessionID: BackgroundTaskExecutionTable.session_id,
          parentSessionID: BackgroundTaskExecutionTable.parent_session_id,
          generation: BackgroundTaskExecutionTable.generation,
          ownerID: BackgroundTaskExecutionTable.owner_id,
          state: BackgroundTaskExecutionTable.state,
        })
        .all()
        .pipe(Effect.orDie)
      yield* Effect.forEach(
        reconciled,
        (execution) => {
          const previous = expired.find(
            (item) => item.sessionID === execution.sessionID && item.generation === execution.generation,
          )
          return Effect.logWarning("background task lease reconciled as expired", {
            sessionID: execution.sessionID,
            parentSessionID: execution.parentSessionID,
            generation: execution.generation,
            ownerID: execution.ownerID,
            expiredAt: time,
            ...(previous
              ? {
                  leaseExpiresAt: previous.leaseExpiresAt,
                  leaseExpiredByMillis: time - previous.leaseExpiresAt,
                  executionAgeMillis: time - previous.timeCreated,
                }
              : {}),
            reason: execution.state === "cancelled" ? "cancel_requested" : "owner_lease_expired",
          })
        },
        { discard: true },
      )
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

    const claimValues = (input: ClaimInput, time: number) => ({
      session_id: input.sessionID,
      parent_session_id: input.parentSessionID,
      generation: input.generation,
      owner_id: ownerID,
      state: "running" as const,
      description: input.description,
      parent_message_id: input.parentMessageID,
      parent_variant: input.parentVariant,
      lease_expires_at: time + leaseMillis,
      delivery: { messageID: MessageID.ascending(), partID: PartID.ascending() },
      wake_required: input.wakeRequired ?? true,
      time_created: time,
      time_updated: time,
    })

    const logLeaseAcquired = (info: Info, acquiredAt: number) =>
      Effect.logInfo("background task lease acquired", {
        sessionID: info.sessionID,
        parentSessionID: info.parentSessionID,
        generation: info.generation,
        ownerID: info.ownerID,
        acquiredAt,
        leaseExpiresAt: info.leaseExpiresAt,
        leaseMillis,
      })

    const replace = Effect.fn("BackgroundTaskExecution.replace")(function* (
      current: Info,
      values: ReturnType<typeof claimValues>,
      allowPendingWake: boolean,
    ) {
      const base = [
        eq(BackgroundTaskExecutionTable.session_id, current.sessionID),
        eq(BackgroundTaskExecutionTable.generation, current.generation),
        eq(BackgroundTaskExecutionTable.state, current.state),
        isNotNull(BackgroundTaskExecutionTable.terminal_delivered_at),
      ]
      const condition = allowPendingWake
        ? and(...base)
        : and(
            ...base,
            or(
              eq(BackgroundTaskExecutionTable.wake_required, false),
              eq(BackgroundTaskExecutionTable.state, "cancelled"),
              isNotNull(BackgroundTaskExecutionTable.wake_claimed_at),
            ),
          )
      return fromRow(
        yield* db
          .update(BackgroundTaskExecutionTable)
          .set({
            ...values,
            cancel_requested_at: null,
            followup_claimed_at: null,
            followup_message_id: null,
            followup_hash: null,
            output: null,
            error: null,
            delivery_owner_id: null,
            delivery_lease_expires_at: null,
            terminal_delivered_at: null,
            wake_owner_id: null,
            wake_lease_expires_at: null,
            wake_claimed_at: null,
          })
          .where(condition)
          .returning()
          .get()
          .pipe(Effect.orDie),
      )
    })

    const claim: Interface["claim"] = Effect.fn("BackgroundTaskExecution.claim")(function* (input) {
      const time = now()
      const values = claimValues(input, time)

      const inserted = yield* db
        .insert(BackgroundTaskExecutionTable)
        .values(values)
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (inserted) {
        const info = fromRow(inserted)!
        yield* logLeaseAcquired(info, time)
        return { status: "claimed", info }
      }

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

      const replaced = yield* replace(current, values, false)
      if (replaced) {
        yield* logLeaseAcquired(replaced, time)
        return { status: "claimed", info: replaced }
      }
      return yield* claim(input)
    })

    const claimAfterObservedTerminal: Interface["claimAfterObservedTerminal"] = Effect.fn(
      "BackgroundTaskExecution.claimAfterObservedTerminal",
    )(function* (input) {
      const ownership = yield* claim(input)
      if (ownership.status !== "terminal") return ownership
      if (ownership.info.generation === input.generation) return ownership
      if (ownership.info.terminalDeliveredAt === undefined) return ownership
      if (ownership.info.delivery.messageID !== input.observedDeliveryMessageID) return ownership
      const time = now()
      const replaced = yield* replace(ownership.info, claimValues(input, time), true)
      if (replaced) {
        yield* logLeaseAcquired(replaced, time)
        return { status: "claimed", info: replaced }
      }
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
      if (renewed) {
        yield* Effect.logInfo("background task lease renewed", {
          sessionID: input.sessionID,
          generation: input.generation,
          ownerID,
          renewedAt: time,
          leaseExpiresAt: time + leaseMillis,
          leaseMillis,
        })
        return "owned"
      }
      const current = yield* get(input.sessionID)
      const result =
        current?.generation === input.generation &&
        current.ownerID === ownerID &&
        current.state === "running" &&
        current.cancelRequestedAt !== undefined
          ? "cancelled"
          : "lost"
      const reason =
        current?.generation !== input.generation
          ? "generation_changed"
          : current.ownerID !== ownerID
            ? "ownership_changed"
            : current.state !== "running"
              ? "execution_not_running"
              : current.cancelRequestedAt !== undefined
                ? "cancel_requested"
                : current.leaseExpiresAt <= time
                  ? "lease_expired"
                  : "heartbeat_condition_failed"
      yield* Effect.logWarning("background task lease heartbeat failed", {
        sessionID: input.sessionID,
        generation: input.generation,
        ownerID,
        failedAt: time,
        result,
        reason,
        ...(current
          ? {
              currentOwnerID: current.ownerID,
              currentState: current.state,
              leaseExpiresAt: current.leaseExpiresAt,
              leaseRemainingMillis: current.leaseExpiresAt - time,
              ...(current.cancelRequestedAt === undefined ? {} : { cancelRequestedAt: current.cancelRequestedAt }),
            }
          : {}),
      })
      return result
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
        const time = now()
        yield* db
          .transaction(
            (tx) =>
              Effect.gen(function* () {
                const descendants = tree(
                  (yield* tx.select().from(BackgroundTaskExecutionTable).all().pipe(Effect.orDie))
                    .map(fromRow)
                    .filter(isInfo),
                  sessionID,
                )
                yield* Effect.forEach(
                  descendants.filter((row) => row.state === "running"),
                  (row) =>
                    tx
                      .update(BackgroundTaskExecutionTable)
                      .set({ cancel_requested_at: time, time_updated: time })
                      .where(
                        and(
                          eq(BackgroundTaskExecutionTable.session_id, row.sessionID),
                          eq(BackgroundTaskExecutionTable.generation, row.generation),
                          eq(BackgroundTaskExecutionTable.state, "running"),
                        ),
                      )
                      .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
                      .get()
                      .pipe(
                        Effect.orDie,
                        Effect.flatMap((cancelled) =>
                          cancelled ? SessionRunLease.requestCancel(tx, row.sessionID, time) : Effect.void,
                        ),
                      ),
                  { discard: true },
                )
              }),
            { behavior: "immediate" },
          )
          .pipe(Effect.orDie)
        return tree(yield* listAll(), sessionID)
      },
    )

    const claimFollowup: Interface["claimFollowup"] = Effect.fn("BackgroundTaskExecution.claimFollowup")(
      function* (input) {
        yield* reconcileExpired()
        const time = now()
        const claimed = yield* db
          .update(BackgroundTaskExecutionTable)
          .set({
            followup_claimed_at: time,
            followup_message_id: input.messageID,
            followup_hash: input.hash,
            time_updated: time,
          })
          .where(
            and(
              eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
              eq(BackgroundTaskExecutionTable.parent_session_id, input.parentSessionID),
              eq(BackgroundTaskExecutionTable.generation, input.generation),
              eq(BackgroundTaskExecutionTable.state, "running"),
              gt(BackgroundTaskExecutionTable.lease_expires_at, time),
              isNull(BackgroundTaskExecutionTable.cancel_requested_at),
              isNull(BackgroundTaskExecutionTable.followup_claimed_at),
            ),
          )
          .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
          .get()
          .pipe(Effect.orDie)
        if (claimed) return "claimed"
        const current = yield* get(input.sessionID)
        if (
          current?.parentSessionID === input.parentSessionID &&
          current?.generation === input.generation &&
          current.state === "running" &&
          current.leaseExpiresAt > time &&
          current.cancelRequestedAt === undefined
        ) {
          if (current.followupMessageID === input.messageID)
            return current.followupHash === input.hash ? "replayed" : "conflict"
          if (current.followupClaimedAt !== undefined) return "already_claimed"
        }
        return "inactive"
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

    const listForParent: Interface["listForParent"] = Effect.fn("BackgroundTaskExecution.listForParent")(
      function* (parentSessionID) {
        yield* reconcileExpired()
        return (yield* db
          .select()
          .from(BackgroundTaskExecutionTable)
          .where(eq(BackgroundTaskExecutionTable.parent_session_id, parentSessionID))
          .all()
          .pipe(Effect.orDie))
          .map(fromRow)
          .filter(isInfo)
      },
    )

    const listPendingHandoffs: Interface["listPendingHandoffs"] = Effect.fn(
      "BackgroundTaskExecution.listPendingHandoffs",
    )(function* (parentSessionID) {
      return (yield* listForParent(parentSessionID)).filter(isPendingHandoff)
    })

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
                  eq(BackgroundTaskExecutionTable.wake_required, true),
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
        const token = `${ownerID}:${crypto.randomUUID()}`
        const claimed = yield* db
          .update(BackgroundTaskExecutionTable)
          .set({
            delivery_owner_id: token,
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
          .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
          .get()
          .pipe(Effect.orDie)
        return claimed ? { token } : undefined
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
                eq(BackgroundTaskExecutionTable.delivery_owner_id, input.token),
                isNull(BackgroundTaskExecutionTable.terminal_delivered_at),
              ),
            )
            .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
            .get()
            .pipe(Effect.orDie),
        )
      },
    )

    const heartbeatDelivery: Interface["heartbeatDelivery"] = Effect.fn(
      "BackgroundTaskExecution.heartbeatDelivery",
    )(function* (input) {
      const time = now()
      const renewed = yield* db
        .update(BackgroundTaskExecutionTable)
        // Leave enough headroom for a heartbeat that is scheduled just before the
        // delivery effect starts. This prevents a second runtime from reclaiming
        // the lease while the first effect is already in flight.
        .set({ delivery_lease_expires_at: time + leaseMillis * 3, time_updated: time })
        .where(
          and(
            eq(BackgroundTaskExecutionTable.session_id, input.sessionID),
            eq(BackgroundTaskExecutionTable.generation, input.generation),
            eq(BackgroundTaskExecutionTable.delivery_owner_id, input.token),
            isNull(BackgroundTaskExecutionTable.terminal_delivered_at),
            gt(BackgroundTaskExecutionTable.delivery_lease_expires_at, time),
          ),
        )
        .returning({ sessionID: BackgroundTaskExecutionTable.session_id })
        .get()
        .pipe(Effect.orDie)
      return renewed ? "owned" : "lost"
    })

    const claimWake: Interface["claimWake"] = Effect.fn("BackgroundTaskExecution.claimWake")(function* (input) {
      const time = now()
      const token = `${ownerID}:${crypto.randomUUID()}`
      const claimed = yield* db
        .update(BackgroundTaskExecutionTable)
        .set({ wake_owner_id: token, wake_lease_expires_at: time + leaseMillis, time_updated: time })
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
        .pipe(Effect.orDie)
      return claimed ? { token } : undefined
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
              eq(BackgroundTaskExecutionTable.wake_owner_id, input.token),
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
                eq(BackgroundTaskExecutionTable.wake_owner_id, input.token),
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
      claimAfterObservedTerminal,
      heartbeat,
      settle,
      requestCancel,
      claimFollowup,
      get,
      list,
      listForParent,
      listPendingHandoffs,
      listRunning,
      pendingTerminals,
      claimDelivery,
      heartbeatDelivery,
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
    parentVariant: row.parent_variant ?? undefined,
    leaseExpiresAt: row.lease_expires_at,
    followupClaimedAt: row.followup_claimed_at ?? undefined,
    followupMessageID: row.followup_message_id ? MessageID.make(row.followup_message_id) : undefined,
    followupHash: row.followup_hash ?? undefined,
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

function isPendingHandoff(info: Info) {
  if (info.state === "running") return true
  if (info.terminalDeliveredAt === undefined) return true
  return info.wakeRequired && info.state !== "cancelled" && info.wakeClaimedAt === undefined
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
