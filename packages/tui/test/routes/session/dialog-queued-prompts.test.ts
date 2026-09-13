import { describe, expect, test } from "bun:test"
import { queuedPromptOptions } from "../../../src/routes/session/dialog-queued-prompts"

describe("queued prompt dialog", () => {
  test("preserves the durable FIFO order and exposes a readable fallback for attachments", () => {
    const options = queuedPromptOptions([
      {
        id: "msg_first",
        sessionID: "ses_1",
        admittedSeq: 1,
        delivery: "queue",
        prompt: { text: "first\nline" },
        timeCreated: 1,
      },
      {
        id: "msg_second",
        sessionID: "ses_1",
        admittedSeq: 2,
        delivery: "queue",
        prompt: { text: "", files: [{ uri: "file:///repo/image.png", mime: "image/png" }] },
        timeCreated: 2,
      },
    ])

    expect(options.map((option) => option.value)).toEqual(["msg_first", "msg_second"])
    expect(options[0]?.title).toBe("first line")
    expect(options[1]?.title).toBe("[attachment]")
    expect(options[0]?.footer).toStartWith("#1 · ")
  })
})
