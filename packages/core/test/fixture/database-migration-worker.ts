import { SqliteClient } from "@effect/sql-sqlite-bun"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect, Schema } from "effect"

const Input = Schema.Struct({
  filename: Schema.String,
  start: Schema.String,
  ready: Schema.String,
  entered: Schema.String,
  peerEntered: Schema.String,
})
const input = Schema.decodeUnknownSync(Input)(
  Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(process.argv[2] ?? ""),
)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* Effect.promise(() => Bun.write(input.ready, "ready"))
      yield* waitForFile(input.start, 5_000)
      yield* DatabaseMigration.applyOnly(db, [
        {
          id: "test_cross_process_incremental",
          up(tx) {
            return Effect.gen(function* () {
              yield* Effect.promise(() => Bun.write(input.entered, "entered"))
              yield* waitForFile(input.peerEntered, 300).pipe(Effect.ignore)
              yield* tx.run("INSERT INTO migration_probe DEFAULT VALUES")
            })
          },
        },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: input.filename, disableWAL: true }))),
  ),
)

function waitForFile(file: string, timeout: number) {
  return Effect.gen(function* () {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (yield* Effect.promise(() => Bun.file(file).exists())) return
      yield* Effect.sleep("10 millis")
    }
    yield* Effect.fail(new Error(`Timed out waiting for ${file}`))
  })
}
