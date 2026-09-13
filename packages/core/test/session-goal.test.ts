import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionGoal } from "@opencode-ai/core/session/goal"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionGoalTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_goal_test")
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    wake: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionGoal.node,
      SessionV2.node,
    ]),
    [[SessionExecution.node, execution]],
  ),
)

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "goal",
      directory: "/project",
      title: "goal",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

describe("SessionGoal", () => {
  it.effect("projects a durable goal without adding a transcript message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const goals = yield* SessionGoal.Service
      const { db } = yield* Database.Service

      const goal = yield* session.goal.set({
        sessionID,
        objective: "Ship the canonical session flow",
        status: "blocked",
        reason: "Awaiting durable sections",
      })

      expect(goal).toMatchObject({
        sessionID,
        objective: "Ship the canonical session flow",
        status: "blocked",
        reason: "Awaiting durable sections",
      })
      expect(yield* session.goal.get(sessionID)).toEqual(goal)
      expect(yield* goals.get(sessionID)).toEqual(goal)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(
        yield* db
          .select()
          .from(SessionGoalTable)
          .where(eq(SessionGoalTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie),
      ).toMatchObject({
        session_id: sessionID,
        objective: "Ship the canonical session flow",
        status: "blocked",
        reason: "Awaiting durable sections",
      })
      expect(
        yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(yield* session.history({ sessionID, limit: 10 })).toMatchObject({
        events: [
          {
            type: "session.next.goal.updated",
            durable: { aggregateID: sessionID, seq: 0, version: 1 },
            data: {
              sessionID,
              goal: {
                objective: "Ship the canonical session flow",
                status: "blocked",
                reason: "Awaiting durable sections",
              },
            },
          },
        ],
        hasMore: false,
      })
    }),
  )

  it.effect("does not append an event for an unchanged goal and clears an omitted reason", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const first = yield* session.goal.set({
        sessionID,
        objective: "Ship the canonical session flow",
        status: "blocked",
        reason: "Awaiting durable sections",
      })
      const repeated = yield* session.goal.set({
        sessionID,
        objective: "Ship the canonical session flow",
        status: "blocked",
        reason: "Awaiting durable sections",
      })

      expect(DateTime.toEpochMillis(repeated.updatedAt)).toBe(DateTime.toEpochMillis(first.updatedAt))
      expect((yield* session.history({ sessionID, limit: 10 })).events).toHaveLength(1)

      const updated = yield* session.goal.set({
        sessionID,
        objective: "Ship the canonical session flow",
        status: "active",
      })

      expect(updated).toMatchObject({
        sessionID,
        objective: "Ship the canonical session flow",
        status: "active",
      })
      expect(updated).not.toHaveProperty("reason")
      expect((yield* session.history({ sessionID, limit: 10 })).events).toHaveLength(2)
    }),
  )

  it.effect("keeps missing sessions distinct from sessions without a goal", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      expect(yield* session.goal.get(sessionID)).toBeUndefined()
      const error = yield* session.goal.get(SessionV2.ID.make("ses_missing_goal")).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "Session.NotFoundError", sessionID: "ses_missing_goal" })
    }),
  )
})
