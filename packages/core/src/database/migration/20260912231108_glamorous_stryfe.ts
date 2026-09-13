import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260912231108_glamorous_stryfe",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_goal\` (
          \`session_id\` text PRIMARY KEY,
          \`objective\` text NOT NULL,
          \`status\` text NOT NULL,
          \`reason\` text,
          \`updated_at\` integer NOT NULL,
          CONSTRAINT \`fk_session_goal_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
