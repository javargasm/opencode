import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260805222957_grey_klaw",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_run_lease\` (
          \`session_id\` text PRIMARY KEY,
          \`owner_id\` text,
          \`owner_pid\` integer,
          \`owner_incarnation_id\` text,
          \`owner_incarnation_port\` integer,
          \`lease_expires_at\` integer,
          \`wake_requested_seq\` integer DEFAULT 0 NOT NULL,
          \`wake_completed_seq\` integer DEFAULT 0 NOT NULL,
          \`cancel_requested_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_run_lease_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`background_task_execution\` ADD \`parent_variant\` text;`)
      yield* tx.run(`ALTER TABLE \`background_task_execution\` ADD \`followup_claimed_at\` integer;`)
      if (yield* tx.get<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'`)) {
        yield* tx.run(`
          UPDATE \`background_task_execution\`
          SET \`parent_variant\` = (
            SELECT json_extract(\`message\`.\`data\`, '$.variant')
            FROM \`message\`
            WHERE \`message\`.\`id\` = \`background_task_execution\`.\`parent_message_id\`
              AND \`message\`.\`session_id\` = \`background_task_execution\`.\`parent_session_id\`
          )
          WHERE \`parent_variant\` IS NULL;
        `)
      }
    })
  },
} satisfies DatabaseMigration.Migration
