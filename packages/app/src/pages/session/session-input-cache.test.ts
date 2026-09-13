import { describe, expect, test } from "bun:test"
import type { SessionInputAdmitted, SessionInputPending } from "@opencode-ai/sdk/v2/client"
import { mergePendingSessionInput } from "./session-input-cache"

const pending = (input: Partial<SessionInputPending> = {}): SessionInputPending => ({
  admittedSeq: 1,
  id: "msg_1",
  sessionID: "ses_1",
  prompt: { text: "first" },
  delivery: "queue",
  timeCreated: 1,
  ...input,
})

const admitted = (input: Partial<SessionInputAdmitted> = {}): SessionInputAdmitted => ({
  admittedSeq: 2,
  id: "msg_2",
  sessionID: "ses_1",
  prompt: { text: "second" },
  delivery: "queue",
  timeCreated: 2,
  ...input,
})

describe("mergePendingSessionInput", () => {
  test("projects a confirmed queue admission into the durable inbox cache in admission order", () => {
    expect(mergePendingSessionInput([pending({ admittedSeq: 3, id: "msg_3" })], admitted())).toEqual([
      pending({ admittedSeq: 2, id: "msg_2", prompt: { text: "second" }, timeCreated: 2 }),
      pending({ admittedSeq: 3, id: "msg_3" }),
    ])
  })

  test("replaces a matching cache entry without duplicating a retried admission", () => {
    expect(
      mergePendingSessionInput(
        [pending({ admittedSeq: 2, id: "msg_2", prompt: { text: "stale" } })],
        admitted({ prompt: { text: "confirmed" } }),
      ),
    ).toEqual([pending({ admittedSeq: 2, id: "msg_2", prompt: { text: "confirmed" }, timeCreated: 2 })])
  })

  test("does not restore an admission that the durable response says was already promoted", () => {
    expect(mergePendingSessionInput([pending({ admittedSeq: 2, id: "msg_2" })], admitted({ promotedSeq: 2 }))).toEqual(
      [],
    )
  })
})
