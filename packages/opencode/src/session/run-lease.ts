import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ProjectV2 } from "@opencode-ai/core/project"
import { SessionRunLeaseTable, SessionTable } from "@opencode-ai/core/session/sql"
import { and, eq, getTableColumns, gt, isNotNull, isNull, sql } from "drizzle-orm"
import { Context, Effect, Layer, Scope } from "effect"
import { ProcessIncarnation } from "./process-incarnation"
import { SessionID } from "./schema"

export type Info = {
  sessionID: SessionID
  ownerID?: string
  ownerPID?: number
  ownerIncarnationID?: string
  ownerIncarnationPort?: number
  leaseExpiresAt?: number
  wakeRequested: number
  wakeCompleted: number
  cancelRequestedAt?: number
}

export type Claim = {
  token: string
  targetRevision: number
}

export interface Interface {
  readonly leaseMillis: number
  readonly requestWake: (sessionID: SessionID) => Effect.Effect<number>
  readonly claim: (sessionID: SessionID) => Effect.Effect<Claim | undefined>
  readonly claimExclusive: (sessionID: SessionID) => Effect.Effect<Claim | undefined>
  readonly claimScoped: (sessionID: SessionID) => Effect.Effect<Claim | undefined, never, Scope.Scope>
  readonly claimExclusiveScoped: (sessionID: SessionID) => Effect.Effect<Claim | undefined, never, Scope.Scope>
  readonly heartbeat: (sessionID: SessionID, token: string) => Effect.Effect<"owned" | "cancelled" | "lost">
  readonly complete: (sessionID: SessionID, token: string, targetRevision: number) => Effect.Effect<boolean>
  readonly release: (sessionID: SessionID, token: string) => Effect.Effect<boolean>
  readonly requestCancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly list: (input: { projectID: ProjectV2.ID; directory: string }) => Effect.Effect<Info[]>
  readonly isBusy: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunLease") {}

export function make(options?: {
  leaseMillis?: number
  now?: () => number
  processID?: number
  isProcessAlive?: (processID: number) => boolean
}) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const incarnation = yield* ProcessIncarnation.Service
    const leaseMillis = options?.leaseMillis ?? 5_000
    const now = options?.now ?? Date.now
    const processID = options?.processID ?? process.pid
    const isProcessAlive = options?.isProcessAlive ?? processAlive

    const ensureRow = Effect.fn("SessionRunLease.ensureRow")(function* (sessionID: SessionID) {
      const time = now()
      yield* db
        .insert(SessionRunLeaseTable)
        .values({
          session_id: sessionID,
          wake_requested_seq: 0,
          wake_completed_seq: 0,
          time_created: time,
          time_updated: time,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const getRow = Effect.fn("SessionRunLease.getRow")(function* (sessionID: SessionID) {
      return yield* db
        .select()
        .from(SessionRunLeaseTable)
        .where(eq(SessionRunLeaseTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
    })

    const get: Interface["get"] = Effect.fn("SessionRunLease.get")(function* (sessionID) {
      return fromRow(yield* getRow(sessionID))
    })

    const requestWake: Interface["requestWake"] = Effect.fn("SessionRunLease.requestWake")(function* (sessionID) {
      const time = now()
      const row = yield* db
        .insert(SessionRunLeaseTable)
        .values({
          session_id: sessionID,
          wake_requested_seq: 1,
          wake_completed_seq: 0,
          time_created: time,
          time_updated: time,
        })
        .onConflictDoUpdate({
          target: SessionRunLeaseTable.session_id,
          set: {
            wake_requested_seq: sql`${SessionRunLeaseTable.wake_requested_seq} + 1`,
            time_updated: time,
          },
        })
        .returning({ revision: SessionRunLeaseTable.wake_requested_seq })
        .get()
        .pipe(Effect.orDie)
      return row.revision
    })

    const acquire = Effect.fn("SessionRunLease.acquire")(function* (sessionID: SessionID, pendingOnly: boolean) {
      yield* ensureRow(sessionID)
      const time = now()
      const current = yield* getRow(sessionID)
      if (!current) return undefined
      if (pendingOnly && current.wake_requested_seq <= current.wake_completed_seq) return undefined
      if (current.owner_id !== null) {
        if (current.lease_expires_at !== null && current.lease_expires_at > time) return undefined
        if (current.owner_pid === null) return undefined
        if (alive(isProcessAlive, current.owner_pid)) {
          if (current.owner_incarnation_id === null || current.owner_incarnation_port === null) return undefined
          if (
            (yield* incarnation.probe({
              incarnationID: current.owner_incarnation_id,
              port: current.owner_incarnation_port,
            })) !== "ended"
          ) {
            return undefined
          }
        }
      }
      const token = `${processID}:${crypto.randomUUID()}`
      const conditions = [
        eq(SessionRunLeaseTable.session_id, sessionID),
        current.owner_id === null
          ? isNull(SessionRunLeaseTable.owner_id)
          : and(
              eq(SessionRunLeaseTable.owner_id, current.owner_id),
              current.owner_pid === null
                ? isNull(SessionRunLeaseTable.owner_pid)
                : eq(SessionRunLeaseTable.owner_pid, current.owner_pid),
              current.owner_incarnation_id === null
                ? isNull(SessionRunLeaseTable.owner_incarnation_id)
                : eq(SessionRunLeaseTable.owner_incarnation_id, current.owner_incarnation_id),
              current.owner_incarnation_port === null
                ? isNull(SessionRunLeaseTable.owner_incarnation_port)
                : eq(SessionRunLeaseTable.owner_incarnation_port, current.owner_incarnation_port),
              current.lease_expires_at === null
                ? isNull(SessionRunLeaseTable.lease_expires_at)
                : eq(SessionRunLeaseTable.lease_expires_at, current.lease_expires_at),
            ),
      ]
      if (pendingOnly)
        conditions.push(gt(SessionRunLeaseTable.wake_requested_seq, SessionRunLeaseTable.wake_completed_seq))
      const row = yield* db
        .update(SessionRunLeaseTable)
        .set({
          owner_id: token,
          owner_pid: processID,
          owner_incarnation_id: incarnation.incarnationID,
          owner_incarnation_port: incarnation.port,
          lease_expires_at: time + leaseMillis,
          cancel_requested_at: null,
          time_updated: time,
        })
        .where(and(...conditions))
        .returning({ targetRevision: SessionRunLeaseTable.wake_requested_seq })
        .get()
        .pipe(Effect.orDie)
      if (!row) return undefined
      return { token, targetRevision: row.targetRevision }
    })

    const claim: Interface["claim"] = Effect.fn("SessionRunLease.claim")((sessionID) => acquire(sessionID, true))
    const claimExclusive: Interface["claimExclusive"] = Effect.fn("SessionRunLease.claimExclusive")((sessionID) =>
      acquire(sessionID, false),
    )
    const heartbeat: Interface["heartbeat"] = Effect.fn("SessionRunLease.heartbeat")(function* (sessionID, token) {
      const time = now()
      const row = yield* db
        .update(SessionRunLeaseTable)
        .set({ lease_expires_at: time + leaseMillis, time_updated: time })
        .where(
          and(
            eq(SessionRunLeaseTable.session_id, sessionID),
            eq(SessionRunLeaseTable.owner_id, token),
            gt(SessionRunLeaseTable.lease_expires_at, time),
            isNull(SessionRunLeaseTable.cancel_requested_at),
          ),
        )
        .returning({ sessionID: SessionRunLeaseTable.session_id })
        .get()
        .pipe(Effect.orDie)
      if (row) return "owned"
      const current = yield* get(sessionID)
      if (current?.ownerID === token && current.cancelRequestedAt !== undefined) return "cancelled"
      return "lost"
    })

    const complete: Interface["complete"] = Effect.fn("SessionRunLease.complete")(
      function* (sessionID, token, targetRevision) {
        const time = now()
        return Boolean(
          yield* db
            .update(SessionRunLeaseTable)
            .set({
              wake_completed_seq: sql`MAX(${SessionRunLeaseTable.wake_completed_seq}, ${targetRevision})`,
              owner_id: null,
              owner_pid: null,
              owner_incarnation_id: null,
              owner_incarnation_port: null,
              lease_expires_at: null,
              time_updated: time,
            })
            .where(
              and(
                eq(SessionRunLeaseTable.session_id, sessionID),
                eq(SessionRunLeaseTable.owner_id, token),
                gt(SessionRunLeaseTable.lease_expires_at, time),
                isNull(SessionRunLeaseTable.cancel_requested_at),
              ),
            )
            .returning({ sessionID: SessionRunLeaseTable.session_id })
            .get()
            .pipe(Effect.orDie),
        )
      },
    )

    const release: Interface["release"] = Effect.fn("SessionRunLease.release")(function* (sessionID, token) {
      const time = now()
      return Boolean(
        yield* db
          .update(SessionRunLeaseTable)
          .set({
            owner_id: null,
            owner_pid: null,
            owner_incarnation_id: null,
            owner_incarnation_port: null,
            lease_expires_at: null,
            time_updated: time,
          })
          .where(and(eq(SessionRunLeaseTable.session_id, sessionID), eq(SessionRunLeaseTable.owner_id, token)))
          .returning({ sessionID: SessionRunLeaseTable.session_id })
          .get()
          .pipe(Effect.orDie),
      )
    })

    const scoped = (claim: (sessionID: SessionID) => Effect.Effect<Claim | undefined>, sessionID: SessionID) =>
      Effect.acquireRelease(claim(sessionID), (current) =>
        current ? release(sessionID, current.token).pipe(Effect.asVoid) : Effect.void,
      )
    const claimScoped: Interface["claimScoped"] = Effect.fn("SessionRunLease.claimScoped")((sessionID) =>
      scoped(claim, sessionID),
    )
    const claimExclusiveScoped: Interface["claimExclusiveScoped"] = Effect.fn("SessionRunLease.claimExclusiveScoped")(
      (sessionID) => scoped(claimExclusive, sessionID),
    )

    const requestCancel: Interface["requestCancel"] = Effect.fn("SessionRunLease.requestCancel")(function* (sessionID) {
      const time = now()
      yield* db
        .update(SessionRunLeaseTable)
        .set({
          cancel_requested_at: time,
          wake_completed_seq: sql`${SessionRunLeaseTable.wake_requested_seq}`,
          time_updated: time,
        })
        .where(eq(SessionRunLeaseTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
    })

    const isBusy: Interface["isBusy"] = Effect.fn("SessionRunLease.isBusy")(function* (sessionID) {
      const time = now()
      return Boolean(
        yield* db
          .select({ sessionID: SessionRunLeaseTable.session_id })
          .from(SessionRunLeaseTable)
          .where(
            and(
              eq(SessionRunLeaseTable.session_id, sessionID),
              isNotNull(SessionRunLeaseTable.owner_id),
              isNotNull(SessionRunLeaseTable.lease_expires_at),
              gt(SessionRunLeaseTable.lease_expires_at, time),
            ),
          )
          .get()
          .pipe(Effect.orDie),
      )
    })

    const list: Interface["list"] = Effect.fn("SessionRunLease.list")(function* (input) {
      const time = now()
      return (yield* db
        .select(getTableColumns(SessionRunLeaseTable))
        .from(SessionRunLeaseTable)
        .innerJoin(SessionTable, eq(SessionRunLeaseTable.session_id, SessionTable.id))
        .where(
          and(
            eq(SessionTable.project_id, input.projectID),
            eq(SessionTable.directory, input.directory),
            isNotNull(SessionRunLeaseTable.owner_id),
            isNotNull(SessionRunLeaseTable.lease_expires_at),
            gt(SessionRunLeaseTable.lease_expires_at, time),
          ),
        )
        .all()
        .pipe(Effect.orDie))
        .map(fromRow)
        .filter(isInfo)
    })

    return Service.of({
      leaseMillis,
      requestWake,
      claim,
      claimExclusive,
      claimScoped,
      claimExclusiveScoped,
      heartbeat,
      complete,
      release,
      requestCancel,
      get,
      list,
      isBusy,
    })
  })
}

function fromRow(row: typeof SessionRunLeaseTable.$inferSelect | undefined): Info | undefined {
  if (!row) return undefined
  return {
    sessionID: SessionID.make(row.session_id),
    ownerID: row.owner_id ?? undefined,
    ownerPID: row.owner_pid ?? undefined,
    ownerIncarnationID: row.owner_incarnation_id ?? undefined,
    ownerIncarnationPort: row.owner_incarnation_port ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    wakeRequested: row.wake_requested_seq,
    wakeCompleted: row.wake_completed_seq,
    cancelRequestedAt: row.cancel_requested_at ?? undefined,
  }
}

function isInfo(info: Info | undefined): info is Info {
  return info !== undefined
}

function alive(check: (processID: number) => boolean, processID: number) {
  try {
    return check(processID)
  } catch {
    return true
  }
}

function processAlive(processID: number) {
  if (!Number.isSafeInteger(processID) || processID <= 0) return true
  try {
    process.kill(processID, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

const layer = Layer.effect(Service, make())

export const node = LayerNode.make({ service: Service, layer, deps: [Database.node, ProcessIncarnation.node] })

export * as SessionRunLease from "./run-lease"
