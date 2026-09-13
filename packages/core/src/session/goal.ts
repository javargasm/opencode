export * as SessionGoal from "./goal"

import { eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer } from "effect"
import { SessionGoal as SessionGoalSchema } from "@opencode-ai/schema/session-goal"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionProjector } from "./projector"
import { SessionSchema } from "./schema"
import { SessionGoalTable } from "./sql"

export const Status = SessionGoalSchema.Status
export type Status = typeof Status.Type
export const Update = SessionGoalSchema.Update
export type Update = typeof Update.Type
export const Info = SessionGoalSchema.Info
export type Info = typeof Info.Type

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info | undefined>
  readonly set: (input: { readonly sessionID: SessionSchema.ID } & Update) => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionGoal") {}

const fromRow = (row: typeof SessionGoalTable.$inferSelect): Info =>
  Info.make({
    sessionID: SessionSchema.ID.make(row.session_id),
    objective: row.objective,
    status: row.status,
    ...(row.reason === null ? {} : { reason: row.reason }),
    updatedAt: DateTime.makeUnsafe(row.updated_at),
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select()
        .from(SessionGoalTable)
        .where(eq(SessionGoalTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row === undefined ? undefined : fromRow(row)
    })

    const set = Effect.fn("SessionGoal.set")(function* (input: { readonly sessionID: SessionSchema.ID } & Update) {
      const existing = yield* get(input.sessionID)
      if (
        existing?.objective === input.objective &&
        existing.status === input.status &&
        existing.reason === input.reason
      ) {
        return existing
      }
      yield* events.publish(SessionEvent.Goal.Updated, {
        sessionID: input.sessionID,
        timestamp: yield* DateTime.now,
        goal: Update.make({
          objective: input.objective,
          status: input.status,
          reason: input.reason,
        }),
      })
      const stored = yield* get(input.sessionID)
      if (stored) return stored
      return yield* Effect.die(`Session goal projection missing for ${input.sessionID}`)
    })

    return Service.of({ get, set })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [Database.node, EventV2.node, SessionProjector.node],
})
