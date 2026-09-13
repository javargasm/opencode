export * as SessionGoal from "./session-goal"

import { Schema } from "effect"
import { SessionID } from "./session-id"
import { DateTimeUtcFromMillis, optional } from "./schema"

export const Status = Schema.Literals(["active", "paused", "blocked", "complete"])
export type Status = typeof Status.Type

export interface Update extends Schema.Schema.Type<typeof Update> {}
export const Update = Schema.Struct({
  objective: Schema.String,
  status: Status,
  reason: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionGoal.Update" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  sessionID: SessionID,
  objective: Schema.String,
  status: Status,
  reason: Schema.String.pipe(optional),
  updatedAt: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionGoal.Info" })
