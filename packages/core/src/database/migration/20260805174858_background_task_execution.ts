import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const requiredColumns = [
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

const addableColumns = [
  ["cancel_requested_at", "integer"],
  ["output", "text"],
  ["error", "text"],
  ["delivery_owner_id", "text"],
  ["delivery_lease_expires_at", "integer"],
  ["terminal_delivered_at", "integer"],
  ["wake_required", "integer DEFAULT false NOT NULL"],
  ["wake_owner_id", "text"],
  ["wake_lease_expires_at", "integer"],
  ["wake_claimed_at", "integer"],
] as const

export default {
  id: "20260805174858_background_task_execution",
  up(tx) {
    return Effect.gen(function* () {
      const exists = yield* tx.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'background_task_execution'`,
      )
      if (!exists) {
        yield* tx.run(`
          CREATE TABLE \`background_task_execution\` (
            \`session_id\` text PRIMARY KEY,
            \`parent_session_id\` text NOT NULL,
            \`generation\` text NOT NULL,
            \`owner_id\` text NOT NULL,
            \`state\` text NOT NULL,
            \`description\` text NOT NULL,
            \`parent_message_id\` text NOT NULL,
            \`lease_expires_at\` integer NOT NULL,
            \`cancel_requested_at\` integer,
            \`output\` text,
            \`error\` text,
            \`delivery\` text NOT NULL,
            \`delivery_owner_id\` text,
            \`delivery_lease_expires_at\` integer,
            \`terminal_delivered_at\` integer,
            \`wake_required\` integer DEFAULT false NOT NULL,
            \`wake_owner_id\` text,
            \`wake_lease_expires_at\` integer,
            \`wake_claimed_at\` integer,
            \`time_created\` integer NOT NULL,
            \`time_updated\` integer NOT NULL,
            CONSTRAINT \`fk_background_task_execution_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
          );
        `)
      }

      const tableInfo = yield* tx.all<{ name: string; pk: number }>(`PRAGMA table_info(\`background_task_execution\`)`)
      const primaryKey = tableInfo.filter((column) => column.pk > 0)
      if (primaryKey.length !== 1 || primaryKey[0]?.name !== "session_id" || primaryKey[0].pk !== 1) {
        yield* Effect.fail(
          new Error("Incompatible background_task_execution table; session_id must be the sole PRIMARY KEY"),
        )
      }

      const foreignKeys = yield* tx.all<{
        table: string
        from: string
        to: string
        on_delete: string
      }>(`PRAGMA foreign_key_list(\`background_task_execution\`)`)
      if (
        !foreignKeys.some(
          (foreignKey) =>
            foreignKey.table === "session" &&
            foreignKey.from === "session_id" &&
            foreignKey.to === "id" &&
            foreignKey.on_delete.toUpperCase() === "CASCADE",
        )
      ) {
        yield* Effect.fail(
          new Error(
            "Incompatible background_task_execution table; session_id must reference session(id) ON DELETE CASCADE",
          ),
        )
      }

      const columns = new Set(tableInfo.map((column) => column.name))
      yield* Effect.forEach(
        addableColumns.filter(([name]) => !columns.has(name)),
        ([name, definition]) => tx.run(`ALTER TABLE \`background_task_execution\` ADD \`${name}\` ${definition};`),
        { discard: true },
      )

      const repaired = new Set(
        (yield* tx.all<{ name: string }>(`PRAGMA table_info(\`background_task_execution\`)`)).map(
          (column) => column.name,
        ),
      )
      const missing = requiredColumns.filter((column) => !repaired.has(column))
      if (missing.length > 0) {
        yield* Effect.fail(
          new Error(`Incompatible background_task_execution table; missing required columns: ${missing.join(", ")}`),
        )
      }

      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`background_task_execution_parent_state_idx\` ON \`background_task_execution\` (\`parent_session_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`background_task_execution_state_lease_idx\` ON \`background_task_execution\` (\`state\`,\`lease_expires_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
