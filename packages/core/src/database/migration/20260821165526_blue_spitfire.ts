import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260821165526_blue_spitfire",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`background_task_execution\` ADD \`followup_message_id\` text;`)
      yield* tx.run(`ALTER TABLE \`background_task_execution\` ADD \`followup_hash\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
