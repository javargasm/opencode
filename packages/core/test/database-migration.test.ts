import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { spawn } from "child_process"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Cause, Deferred, Effect, Exit, Layer, Ref } from "effect"
import { eq, inArray, sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import sessionUsageMigration from "@opencode-ai/core/database/migration/20260510033149_session_usage"
import normalizeStoragePathsMigration from "@opencode-ai/core/database/migration/20260601010001_normalize_storage_paths"
import sessionMessageProjectionOrderMigration from "@opencode-ai/core/database/migration/20260603040000_session_message_projection_order"
import eventSourcedSessionInputMigration from "@opencode-ai/core/database/migration/20260604172448_event_sourced_session_input"
import contextEpochAgentMigration from "@opencode-ai/core/database/migration/20260605042240_add_context_epoch_agent"
import simplifyIntegrationCredentialsMigration from "@opencode-ai/core/database/migration/20260611192811_lush_chimera"
import simplifySessionInputMigration from "@opencode-ai/core/database/migration/20260622202450_simplify_session_input"
import backgroundTaskExecutionMigration from "@opencode-ai/core/database/migration/20260805174858_background_task_execution"
import sessionRunLeaseMigration from "@opencode-ai/core/database/migration/20260805222957_grey_klaw"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import sessionMetadataMigration from "@opencode-ai/core/database/migration/20260511173437_session-metadata"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const backgroundTaskExecutionColumns = [
  "session_id",
  "parent_session_id",
  "generation",
  "owner_id",
  "state",
  "description",
  "parent_message_id",
  "lease_expires_at",
  "cancel_requested_at",
  "output",
  "error",
  "delivery",
  "delivery_owner_id",
  "delivery_lease_expires_at",
  "terminal_delivered_at",
  "wake_required",
  "wake_owner_id",
  "wake_lease_expires_at",
  "wake_claimed_at",
  "time_created",
  "time_updated",
]

const backgroundTaskExecutionIndexes = [
  "background_task_execution_parent_state_idx",
  "background_task_execution_state_lease_idx",
]

describe("DatabaseMigration", () => {
  test("keeps simultaneous in-process migration callers idempotent", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "simultaneous-migration.sqlite")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstContext = yield* Layer.build(Layer.fresh(SqliteClient.layer({ filename })))
          const secondContext = yield* Layer.build(Layer.fresh(SqliteClient.layer({ filename })))
          const first = yield* makeDb.pipe(Effect.provide(firstContext))
          const second = yield* makeDb.pipe(Effect.provide(secondContext))
          const entered = yield* Ref.make(0)
          const ready = yield* Deferred.make<void>()
          const concurrentMigration: DatabaseMigration.Migration = {
            id: "test_simultaneous_connections",
            up(tx) {
              return Effect.gen(function* () {
                if ((yield* Ref.updateAndGet(entered, (count) => count + 1)) === 2) {
                  yield* Deferred.succeed(ready, undefined)
                }
                yield* Deferred.await(ready).pipe(Effect.timeout("100 millis"), Effect.ignore)
                yield* tx.run(`CREATE TABLE concurrent_migration_probe (id text PRIMARY KEY)`)
              })
            },
          }
          yield* first.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)

          const exit = yield* Effect.all(
            [
              DatabaseMigration.applyOnly(first, [concurrentMigration]),
              DatabaseMigration.applyOnly(second, [concurrentMigration]),
            ],
            { concurrency: "unbounded", discard: true },
          ).pipe(Effect.exit)

          expect(Exit.isSuccess(exit)).toBe(true)
          expect(
            yield* first.get<{ count: number }>(
              sql`SELECT count(*) AS count FROM migration WHERE id = ${concurrentMigration.id}`,
            ),
          ).toEqual({ count: 1 })
        }),
      ),
    )
  })

  test("serializes one incremental migration across separate processes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "cross-process-migration.sqlite")
    const start = path.join(tmp.path, "start")
    const firstReady = path.join(tmp.path, "first-ready")
    const secondReady = path.join(tmp.path, "second-ready")
    const firstEntered = path.join(tmp.path, "first-entered")
    const secondEntered = path.join(tmp.path, "second-entered")

    await withDatabase(
      filename,
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE migration_probe (id integer PRIMARY KEY AUTOINCREMENT)`)
      }),
    )

    const first = migrationWorker({
      filename,
      start,
      ready: firstReady,
      entered: firstEntered,
      peerEntered: secondEntered,
    })
    const second = migrationWorker({
      filename,
      start,
      ready: secondReady,
      entered: secondEntered,
      peerEntered: firstEntered,
    })
    const results = Promise.all([waitForChild(first), waitForChild(second)])
    await Promise.all([waitForFile(firstReady), waitForFile(secondReady)])
    await Bun.write(start, "go")

    expect(await results).toEqual([
      { code: 0, stderr: "" },
      { code: 0, stderr: "" },
    ])
    await withDatabase(
      filename,
      Effect.gen(function* () {
        const db = yield* makeDb
        expect(yield* db.get<{ count: number }>(sql`SELECT count(*) AS count FROM migration_probe`)).toEqual({
          count: 1,
        })
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT count(*) AS count FROM migration WHERE id = 'test_cross_process_incremental'`,
          ),
        ).toEqual({ count: 1 })
      }),
    )
  })

  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })
  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("applies tracked migrations to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_input'`),
        ).toEqual({ name: "session_input" })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_context_epoch'`),
        ).toEqual({ name: "session_context_epoch" })
        expect(
          yield* db.get(
            sql`SELECT name FROM pragma_table_info('session_context_epoch') WHERE name IN ('agent', 'replacement_seq', 'revision')`,
          ),
        ).toBeUndefined()
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_run_lease'`),
        ).toEqual({ name: "session_run_lease" })
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(background_task_execution)`)).map(
            (column) => column.name,
          ),
        ).toEqual(expect.arrayContaining(["parent_variant", "followup_claimed_at"]))
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: migrations.length })
        expect(
          yield* db.all(
            sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_aggregate_seq_idx', 'event_aggregate_type_seq_idx', 'session_input_session_pending_seq_idx', 'session_input_session_pending_delivery_seq_idx', 'session_input_session_admitted_seq_idx', 'session_input_session_promoted_seq_idx', 'session_message_session_idx', 'session_message_session_type_idx', 'session_message_session_seq_idx', 'session_message_session_type_seq_idx', 'session_message_session_time_created_id_idx') ORDER BY name`,
          ),
        ).toEqual([
          { name: "event_aggregate_seq_idx" },
          { name: "event_aggregate_type_seq_idx" },
          { name: "session_input_session_admitted_seq_idx" },
          { name: "session_input_session_pending_delivery_seq_idx" },
          { name: "session_input_session_promoted_seq_idx" },
          { name: "session_message_session_seq_idx" },
          { name: "session_message_session_time_created_id_idx" },
          { name: "session_message_session_type_seq_idx" },
        ])
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("backfills existing Context Epoch rows to the build agent", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE session_context_epoch (session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL, replacement_seq integer, revision integer DEFAULT 0 NOT NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('ses_existing', 'baseline', '{}', 0)`,
        )

        yield* DatabaseMigration.applyOnly(db, [contextEpochAgentMigration])

        expect(yield* db.get(sql`SELECT agent FROM session_context_epoch WHERE session_id = 'ses_existing'`)).toEqual({
          agent: "build",
        })
      }),
    )
  })

  test("keeps legacy credential fields nullable", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE credential (id text PRIMARY KEY, connector_id text NOT NULL, method_id text NOT NULL, label text NOT NULL, value text NOT NULL, active integer DEFAULT false NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE UNIQUE INDEX credential_connector_active_idx ON credential (connector_id) WHERE active = 1`,
        )
        yield* DatabaseMigration.applyOnly(db, [simplifyIntegrationCredentialsMigration])

        yield* db.run(
          sql`INSERT INTO credential (id, connector_id, method_id, label, value, active, time_created, time_updated) VALUES ('legacy', 'openai', 'oauth', 'Legacy', '{}', 1, 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('current', 'anthropic', 'Current', '{}', 2, 2)`,
        )
        expect(yield* db.get(sql`SELECT connector_id, method_id, active FROM credential WHERE id = 'current'`)).toEqual(
          { connector_id: null, method_id: null, active: null },
        )
      }),
    )
  })

  test("resets beta history and rebuilds event-sourced Session input storage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, workspace_id text)`)
        yield* db.run(sql`CREATE TABLE workspace (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE part (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq)`)
        yield* db.run(sql`CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE INDEX session_message_session_seq_idx ON session_message (session_id, seq)`)
        yield* db.run(
          sql`CREATE TABLE session_input (seq integer PRIMARY KEY AUTOINCREMENT, id text NOT NULL UNIQUE, session_id text NOT NULL, prompt text NOT NULL, delivery text NOT NULL, promoted_seq integer, time_created integer NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_input_session_pending_delivery_seq_idx ON session_input (session_id, promoted_seq, delivery, seq)`,
        )
        yield* db.run(sql`INSERT INTO session (id, workspace_id) VALUES ('session', 'wrk_old')`)
        yield* db.run(sql`INSERT INTO workspace (id) VALUES ('wrk_old')`)
        yield* db.run(sql`INSERT INTO message (id) VALUES ('message')`)
        yield* db.run(sql`INSERT INTO part (id) VALUES ('part')`)
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 0)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('evt_old', 'session', 0, 'old.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('msg_old', 'session', 'user', 0, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, time_created) VALUES ('msg_pending', 'session', '{}', 'steer', 1)`,
        )

        yield* DatabaseMigration.applyOnly(db, [eventSourcedSessionInputMigration])

        expect(yield* db.all(sql`SELECT id, workspace_id FROM session`)).toEqual([
          { id: "session", workspace_id: null },
        ])
        expect(yield* db.all(sql`SELECT id FROM workspace`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM message`)).toEqual([{ id: "message" }])
        expect(yield* db.all(sql`SELECT id FROM part`)).toEqual([{ id: "part" }])
        expect(yield* db.all(sql`SELECT id FROM event`)).toEqual([])
        expect(yield* db.all(sql`SELECT aggregate_id FROM event_sequence`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])
        expect(yield* db.all(sql`SELECT id FROM session_input`)).toEqual([])
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_input)`)).map((column) => column.name),
        ).toEqual(["id", "session_id", "prompt", "delivery", "admitted_seq", "promoted_seq", "time_created"])
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_message)`)).find(
            (index) => index.name === "session_message_session_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(event)`)).find(
            (index) => index.name === "event_aggregate_seq_idx",
          ),
        ).toMatchObject({ unique: 1 })
        expect(
          (yield* db.all<{ name: string; unique: number }>(sql`PRAGMA index_list(session_input)`)).filter((index) =>
            ["session_input_session_admitted_seq_idx", "session_input_session_promoted_seq_idx"].includes(index.name),
          ),
        ).toEqual([
          expect.objectContaining({ name: "session_input_session_promoted_seq_idx", unique: 1 }),
          expect.objectContaining({ name: "session_input_session_admitted_seq_idx", unique: 1 }),
        ])
      }),
    )
  })

  test("preserves canonical V1 state and restarts its event stream", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* DatabaseMigration.apply(db)
        yield* db.run(
          sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`,
        )
        yield* db.run(
          sql`INSERT INTO workspace (id, type, project_id, time_used) VALUES ('workspace', 'local', 'global', 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, project_id, workspace_id, slug, directory, title, version, time_created, time_updated) VALUES ('session', 'global', 'workspace', 'session', '/project', 'Before', 'test', 1, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('message', 'session', 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('part', 'message', 'session', 1, 1, '{}')`,
        )
        yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('session', 9)`)
        yield* db.run(
          sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES ('event', 'session', 9, 'session.updated.1', '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_input (id, session_id, prompt, delivery, admitted_seq, time_created) VALUES ('input', 'session', '{}', 'steer', 9, 1)`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('projected', 'session', 'user', 9, 1, 1, '{}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES ('session', 'baseline', '{}', 9)`,
        )
        yield* db.run(sql`DELETE FROM migration WHERE id = ${simplifySessionInputMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [simplifySessionInputMigration])

        const database = Layer.succeed(Database.Service, { db })
        yield* EventV2.Service.use((service) =>
          service.publish(SessionV1.Event.Updated, {
            sessionID: SessionSchema.ID.make("session"),
            info: {
              id: SessionSchema.ID.make("session"),
              slug: "session",
              projectID: ProjectV2.ID.global,
              directory: "/project",
              title: "After",
              version: "test",
              time: { created: 1, updated: 2 },
            },
          }),
        ).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([EventV2.node, SessionProjector.node]), [[Database.node, database]]),
          ),
        )

        expect(
          yield* db.get(sql`
            SELECT
              (SELECT title FROM session WHERE id = 'session') AS title,
              (SELECT workspace_id FROM session WHERE id = 'session') AS workspaceID,
              (SELECT COUNT(*) FROM message WHERE id = 'message') AS messages,
              (SELECT COUNT(*) FROM part WHERE id = 'part') AS parts,
              (SELECT COUNT(*) FROM workspace) AS workspaces,
              (SELECT COUNT(*) FROM session_input) AS sessionInputs,
              (SELECT COUNT(*) FROM session_message) AS sessionMessages,
              (SELECT COUNT(*) FROM session_context_epoch) AS contextEpochs,
              (SELECT seq FROM event_sequence WHERE aggregate_id = 'session') AS seq,
              (SELECT type FROM event WHERE aggregate_id = 'session') AS eventType
          `),
        ).toEqual({
          title: "After",
          workspaceID: null,
          messages: 1,
          parts: 1,
          workspaces: 0,
          sessionInputs: 0,
          sessionMessages: 0,
          contextEpochs: 0,
          seq: 0,
          eventType: "session.updated.1",
        })
      }),
    )
  })

  test("resets incompatible projected Session messages before adding sequence order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(sql`CREATE TABLE event (id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_time_created_id_idx ON session_message (session_id, time_created, id)`,
        )
        yield* db.run(
          sql`CREATE INDEX session_message_session_type_time_created_id_idx ON session_message (session_id, type, time_created, id)`,
        )
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy_message', 'session', 1, 1, '{"role":"user"}')`,
        )
        yield* db.run(
          sql`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('legacy_part', 'legacy_message', 'session', 1, 1, '{"type":"text","text":"hello"}')`,
        )
        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES ('stale_projection', 'session', 'user', 1, 1, '{}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionMessageProjectionOrderMigration])

        expect(yield* db.all(sql`SELECT id, session_id, data FROM message`)).toEqual([
          { id: "legacy_message", session_id: "session", data: '{"role":"user"}' },
        ])
        expect(yield* db.all(sql`SELECT id, message_id, session_id, data FROM part`)).toEqual([
          {
            id: "legacy_part",
            message_id: "legacy_message",
            session_id: "session",
            data: '{"type":"text","text":"hello"}',
          },
        ])
        expect(yield* db.all(sql`SELECT id FROM session_message`)).toEqual([])

        yield* db.run(
          sql`INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES ('fresh_projection', 'session', 'user', 7, 2, 2, '{}')`,
        )
        expect(yield* db.get(sql`SELECT id, seq FROM session_message`)).toEqual({ id: "fresh_projection", seq: 7 })
      }),
    )
  })

  test("runs session usage backfill in order with schema changes", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, time_updated integer NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session (id, time_updated) VALUES ('session_1', 1)`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('message_1', 'session_1', '{"role":"assistant","cost":1.25,"tokens":{"input":2,"output":3,"reasoning":4,"cache":{"read":5,"write":6}}}')`,
        )

        yield* DatabaseMigration.applyOnly(db, [sessionUsageMigration])

        expect(
          yield* db.get(
            sql`SELECT cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = 'session_1'`,
          ),
        ).toEqual({
          cost: 1.25,
          tokens_input: 2,
          tokens_output: 3,
          tokens_reasoning: 4,
          tokens_cache_read: 5,
          tokens_cache_write: 6,
        })
      }),
    )
  })

  test("normalizes Windows storage paths and leaves POSIX paths untouched", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, path text)`)
        // Windows-shaped rows (drive + backslash) must be normalized.
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"win"}, ${"C:\\Repo\\Thing"}, ${JSON.stringify([
            "C:\\Repo\\Thing\\sandbox",
          ])})`,
        )
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"win"}, ${"C:\\Repo\\Thing\\packages\\api"}, ${"packages\\api"})`,
        )
        // UNC worktrees and their sandboxes must normalize too (not just drive paths).
        yield* db.run(
          sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"unc"}, ${"\\\\server\\share"}, ${JSON.stringify([
            "\\\\server\\share\\sandbox",
          ])})`,
        )
        // The "/" worktree sentinel and POSIX paths (including a pathological
        // backslash in a POSIX filename) must survive byte-for-byte.
        yield* db.run(sql`INSERT INTO project (id, worktree, sandboxes) VALUES (${"global"}, ${"/"}, ${"[]"})`)
        yield* db.run(
          sql`INSERT INTO session (id, directory, path) VALUES (${"posix"}, ${"/home/me/we\\ird"}, ${"src\\weird"})`,
        )

        yield* DatabaseMigration.applyOnly(db, [normalizeStoragePathsMigration])

        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'win'`)).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'win'`)).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })
        expect(yield* db.get(sql`SELECT worktree, sandboxes FROM project WHERE id = 'unc'`)).toEqual({
          worktree: "//server/share",
          sandboxes: JSON.stringify(["//server/share/sandbox"]),
        })
        expect(yield* db.get(sql`SELECT worktree FROM project WHERE id = 'global'`)).toEqual({ worktree: "/" })
        expect(yield* db.get(sql`SELECT directory, path FROM session WHERE id = 'posix'`)).toEqual({
          directory: "/home/me/we\\ird",
          path: "src\\weird",
        })
      }),
    )
  })

  test("maps native Windows paths through database columns", async () => {
    if (process.platform !== "win32") return
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const projectID = ProjectV2.ID.make("codec_project")
        const worktree = AbsolutePath.make("C:\\Repo\\Thing")
        const sandbox = AbsolutePath.make("C:\\Repo\\Thing\\sandbox")
        const directory = "C:\\Repo\\Thing\\packages\\api"
        const sessionID = SessionSchema.ID.make("ses_codec")

        expect(() =>
          Effect.runSync(
            db
              .insert(ProjectTable)
              .values({
                id: ProjectV2.ID.make("invalid_path"),
                worktree: AbsolutePath.make("not-absolute"),
                sandboxes: [],
                time_created: 1,
                time_updated: 1,
              })
              .run(),
          ),
        ).toThrow()

        yield* db
          .insert(ProjectTable)
          .values({
            id: projectID,
            worktree,
            sandboxes: [sandbox],
            time_created: 1,
            time_updated: 1,
          })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "codec",
            directory,
            path: "packages\\api",
            title: "Codec",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()

        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({
          worktree: "C:/Repo/Thing",
          sandboxes: JSON.stringify(["C:/Repo/Thing/sandbox"]),
        })
        expect(
          yield* db.get<{ directory: string; path: string }>(
            sql`SELECT directory, path FROM session WHERE id = ${sessionID}`,
          ),
        ).toEqual({
          directory: "C:/Repo/Thing/packages/api",
          path: "packages/api",
        })

        const project = yield* db.select().from(ProjectTable).where(eq(ProjectTable.worktree, worktree)).get()
        const session = yield* db.select().from(SessionTable).where(eq(SessionTable.directory, directory)).get()
        expect(project?.worktree).toBe(worktree)
        expect(project?.sandboxes).toEqual([sandbox])
        expect(session?.directory).toBe(directory)
        expect(session?.path).toBe("packages/api")

        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.path, "packages\\api")).get())?.id).toBe(
          sessionID,
        )

        const moved = AbsolutePath.make("D:\\Moved\\Thing")
        const updated = yield* db
          .update(ProjectTable)
          .set({ worktree: moved, sandboxes: [moved] })
          .where(eq(ProjectTable.id, projectID))
          .returning()
          .get()
        expect(updated?.worktree).toBe(moved)
        expect(updated?.sandboxes).toEqual([moved])
        expect(
          yield* db.get<{ worktree: string; sandboxes: string }>(
            sql`SELECT worktree, sandboxes FROM project WHERE id = ${projectID}`,
          ),
        ).toEqual({ worktree: "D:/Moved/Thing", sandboxes: JSON.stringify(["D:/Moved/Thing"]) })
        expect(
          (yield* db
            .select()
            .from(ProjectTable)
            .where(inArray(ProjectTable.worktree, [moved]))
            .get())?.id,
        ).toBe(projectID)

        yield* db.run(sql`UPDATE project SET worktree = ${"not-absolute"} WHERE id = ${projectID}`)
        expect(() =>
          Effect.runSync(db.select().from(ProjectTable).where(eq(ProjectTable.id, projectID)).get()),
        ).toThrow()
      }),
    )
  })

  test("imports existing drizzle migration state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.get(sql`SELECT id FROM migration`)).toEqual({ id: "20260127222353_familiar_lady_ursula" })
      }),
    )
  })

  test("does not replay a migrated session metadata column", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260511173437_session-metadata', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260511173437_session-metadata" }])
      }),
    )
  })

  test("accepts the temporary replacement session metadata migration id", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, metadata text)`)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('20260530232709_lovely_romulus', 1)`)

        yield* DatabaseMigration.applyOnly(db, [sessionMetadataMigration])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([
          { id: "20260511173437_session-metadata" },
          { id: "20260530232709_lovely_romulus" },
        ])
      }),
    )
  })

  test("creates the consolidated background execution schema on a fresh database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)

        yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration])
        yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration])

        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(background_task_execution)`)).map(
            (column) => column.name,
          ),
        ).toEqual(backgroundTaskExecutionColumns)
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA index_list(background_task_execution)`)).map(
            (index) => index.name,
          ),
        ).toEqual(expect.arrayContaining(backgroundTaskExecutionIndexes))
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT count(*) AS count FROM migration WHERE id = ${backgroundTaskExecutionMigration.id}`,
          ),
        ).toEqual({ count: 1 })
      }),
    )
  })

  test("upgrades the consolidated background execution schema with session run authority", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, data text NOT NULL)`)
        yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration])
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_child')`)
        yield* db.run(
          sql`INSERT INTO message (id, session_id, data) VALUES ('msg_parent', 'ses_parent', ${JSON.stringify({ role: "assistant", variant: "xhigh" })})`,
        )
        yield* db.run(sql`
          INSERT INTO background_task_execution (
            session_id,
            parent_session_id,
            generation,
            owner_id,
            state,
            description,
            parent_message_id,
            lease_expires_at,
            delivery,
            time_created,
            time_updated
          ) VALUES (
            'ses_child',
            'ses_parent',
            'generation-1',
            'owner-1',
            'running',
            'child',
            'msg_parent',
            1000,
            '{"messageID":"msg_delivery","partID":"part_delivery"}',
            1,
            1
          )
        `)

        yield* DatabaseMigration.applyOnly(db, [sessionRunLeaseMigration])

        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(background_task_execution)`)).map(
            (column) => column.name,
          ),
        ).toEqual(expect.arrayContaining(["parent_variant", "followup_claimed_at"]))
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session_run_lease)`)).map((column) => column.name),
        ).toEqual([
          "session_id",
          "owner_id",
          "owner_pid",
          "owner_incarnation_id",
          "owner_incarnation_port",
          "lease_expires_at",
          "wake_requested_seq",
          "wake_completed_seq",
          "cancel_requested_at",
          "time_created",
          "time_updated",
        ])
        expect(
          yield* db.get(sql`SELECT parent_variant FROM background_task_execution WHERE session_id = 'ses_child'`),
        ).toEqual({ parent_variant: "xhigh" })
      }),
    )
  })

  test("accepts the legacy background execution superset and records the consolidated migration once", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE background_task_execution (
            session_id text PRIMARY KEY,
            parent_session_id text NOT NULL,
            generation text NOT NULL,
            owner_id text NOT NULL,
            state text NOT NULL,
            description text NOT NULL,
            parent_message_id text NOT NULL,
            lease_expires_at integer NOT NULL,
            cancel_requested_at integer,
            output text,
            error text,
            delivery text NOT NULL,
            delivery_owner_id text,
            delivery_lease_expires_at integer,
            terminal_delivered_at integer,
            wake_required integer DEFAULT false NOT NULL,
            wake_owner_id text,
            wake_lease_expires_at integer,
            wake_claimed_at integer,
            delete_on_completion integer DEFAULT false NOT NULL,
            cleanup_owner_id text,
            cleanup_lease_expires_at integer,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* Effect.forEach(
          [
            "20260805071903_background_task_execution",
            "20260805083814_background_task_recovery",
            "20260805085316_background_task_wake_requirement",
            "20260805133744_little_bug",
          ],
          (id) => db.run(sql`INSERT INTO migration (id, time_completed) VALUES (${id}, 1)`),
          { discard: true },
        )

        yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration])
        yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration])

        const columns = (yield* db.all<{ name: string }>(sql`PRAGMA table_info(background_task_execution)`)).map(
          (column) => column.name,
        )
        expect(columns).toEqual(expect.arrayContaining(backgroundTaskExecutionColumns))
        expect(columns).toEqual(
          expect.arrayContaining(["delete_on_completion", "cleanup_owner_id", "cleanup_lease_expires_at"]),
        )
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA index_list(background_task_execution)`)).map(
            (index) => index.name,
          ),
        ).toEqual(expect.arrayContaining(backgroundTaskExecutionIndexes))
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT count(*) AS count FROM migration WHERE id = ${backgroundTaskExecutionMigration.id}`,
          ),
        ).toEqual({ count: 1 })
      }),
    )
  })

  test("repairs an interrupted compatible background execution table without rebuilding it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE background_task_execution (
            session_id text PRIMARY KEY,
            parent_session_id text NOT NULL,
            generation text NOT NULL,
            owner_id text NOT NULL,
            state text NOT NULL,
            description text NOT NULL,
            parent_message_id text NOT NULL,
            lease_expires_at integer NOT NULL,
            delivery text NOT NULL,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)
        yield* db.run(sql`
          INSERT INTO background_task_execution (
            session_id,
            parent_session_id,
            generation,
            owner_id,
            state,
            description,
            parent_message_id,
            lease_expires_at,
            delivery,
            time_created,
            time_updated
          ) VALUES ('child', 'parent', 'generation', 'owner', 'completed', 'description', 'message', 1, '{}', 1, 1)
        `)

        yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration])

        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA table_info(background_task_execution)`)).map(
            (column) => column.name,
          ),
        ).toEqual(expect.arrayContaining(backgroundTaskExecutionColumns))
        expect(yield* db.get(sql`SELECT session_id, wake_required FROM background_task_execution`)).toEqual({
          session_id: "child",
          wake_required: 0,
        })
        expect(
          (yield* db.all<{ name: string }>(sql`PRAGMA index_list(background_task_execution)`)).map(
            (index) => index.name,
          ),
        ).toEqual(expect.arrayContaining(backgroundTaskExecutionIndexes))
      }),
    )
  })

  test("does not journal an incompatible partial background execution table", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE background_task_execution (
            session_id text PRIMARY KEY,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)

        const result = yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration]).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT count(*) AS count FROM migration WHERE id = ${backgroundTaskExecutionMigration.id}`,
          ),
        ).toEqual({ count: 0 })
      }),
    )
  })

  test("does not journal a background execution table with an alternate primary key", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE background_task_execution (
            session_id text NOT NULL,
            parent_session_id text NOT NULL,
            generation text PRIMARY KEY,
            owner_id text NOT NULL,
            state text NOT NULL,
            description text NOT NULL,
            parent_message_id text NOT NULL,
            lease_expires_at integer NOT NULL,
            cancel_requested_at integer,
            output text,
            error text,
            delivery text NOT NULL,
            delivery_owner_id text,
            delivery_lease_expires_at integer,
            terminal_delivered_at integer,
            wake_required integer DEFAULT false NOT NULL,
            wake_owner_id text,
            wake_lease_expires_at integer,
            wake_claimed_at integer,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
          )
        `)

        const result = yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration]).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain("session_id must be the sole PRIMARY KEY")
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT count(*) AS count FROM migration WHERE id = ${backgroundTaskExecutionMigration.id}`,
          ),
        ).toEqual({ count: 0 })
      }),
    )
  })

  test("does not journal a background execution table with a restrictive session foreign key", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE background_task_execution (
            session_id text PRIMARY KEY,
            parent_session_id text NOT NULL,
            generation text NOT NULL,
            owner_id text NOT NULL,
            state text NOT NULL,
            description text NOT NULL,
            parent_message_id text NOT NULL,
            lease_expires_at integer NOT NULL,
            cancel_requested_at integer,
            output text,
            error text,
            delivery text NOT NULL,
            delivery_owner_id text,
            delivery_lease_expires_at integer,
            terminal_delivered_at integer,
            wake_required integer DEFAULT false NOT NULL,
            wake_owner_id text,
            wake_lease_expires_at integer,
            wake_claimed_at integer,
            time_created integer NOT NULL,
            time_updated integer NOT NULL,
            FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE RESTRICT
          )
        `)

        const result = yield* DatabaseMigration.applyOnly(db, [backgroundTaskExecutionMigration]).pipe(Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.pretty(result.cause)).toContain("session_id must reference session(id) ON DELETE CASCADE")
        }
        expect(
          yield* db.get<{ count: number }>(
            sql`SELECT count(*) AS count FROM migration WHERE id = ${backgroundTaskExecutionMigration.id}`,
          ),
        ).toEqual({ count: 0 })
      }),
    )
  })

  test("skips drizzle import when migration table already has state", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, '20260127222353_familiar_lady_ursula', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])

        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }])
      }),
    )
  })
})

function withDatabase<A, E>(filename: string, effect: Effect.Effect<A, E, SqlClientService>) {
  return Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(SqliteClient.layer({ filename, disableWAL: true })))),
  )
}

function migrationWorker(input: {
  filename: string
  start: string
  ready: string
  entered: string
  peerEntered: string
}) {
  return spawn(
    process.execPath,
    [path.join(import.meta.dir, "fixture/database-migration-worker.ts"), JSON.stringify(input)],
    { cwd: path.join(import.meta.dir, ".."), stdio: ["ignore", "ignore", "pipe"] },
  )
}

function waitForChild(child: ReturnType<typeof migrationWorker>) {
  return new Promise<{ code: number; stderr: string }>((resolve, reject) => {
    const stderr: Buffer[] = []
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.once("error", reject)
    child.once("close", (code) => resolve({ code: code ?? 1, stderr: Buffer.concat(stderr).toString() }))
  })
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await Bun.file(file).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${file}`)
}
