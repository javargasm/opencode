export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

export function apply(db: Database) {
  return lock.withPermit(
    db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const tables = yield* tx.all<{ name: string }>(
              sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
            )
            if (tables.some((table) => table.name === "session")) return false
            if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
            yield* schema.up(tx)
            yield* tx.run(
              sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
            )
            yield* Effect.forEach(migrations, (migration) =>
              tx.run(
                sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
              ),
            )
            return true
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.flatMap((bootstrapped) => (bootstrapped ? Effect.void : applyOnlyUnlocked(db, migrations)))),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return lock.withPermit(applyOnlyUnlocked(db, input))
}

function applyOnlyUnlocked(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    const completed = yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* tx.run(
            sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          let current = new Set(
            (yield* tx.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
          )
          if (current.size > 0) return current
          if (
            !(yield* tx.get(
              sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`,
            ))
          ) {
            return current
          }
          yield* tx.run(sql`
            INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
            SELECT name, ${Date.now()}
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE name IS NOT NULL
          `)
          current = new Set(
            (yield* tx.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
          )
          return current
        }),
      { behavior: "immediate" },
    )

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            if (
              yield* tx.get<{ id: string }>(
                sql`SELECT id FROM ${sql.identifier("migration")} WHERE id = ${migration.id}`,
              )
            ) {
              return
            }
            yield* migration.up(tx)
            yield* tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            )
          }),
        { behavior: "immediate" },
      )
    }
  })
}
