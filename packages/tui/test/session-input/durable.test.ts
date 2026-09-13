import { describe, expect, test } from "bun:test"
import { admitQueue, pendingInputs, toDurablePromptInput } from "../../src/session-input/durable"

describe("durable TUI session input", () => {
  test("serializes supported composer parts into the V2 prompt contract", () => {
    expect(
      toDurablePromptInput([
        { type: "text", text: "review this" },
        { type: "file", mime: "text/plain", url: "file:///repo/a.txt", filename: "a.txt" },
        { type: "agent", name: "planner" },
      ]),
    ).toEqual({
      text: "review this",
      files: [{ uri: "file:///repo/a.txt", name: "a.txt" }],
      agents: [{ name: "planner" }],
    })
  })

  test("admits Queue inputs with a caller-stable ID and no resume", async () => {
    const calls: unknown[] = []
    const client = {
      v2: {
        session: {
          prompt(input: unknown) {
            calls.push(input)
            return Promise.resolve({})
          },
          pendingInputs() {
            return Promise.resolve({ data: { data: [] } })
          },
        },
      },
    }

    await admitQueue(client, { sessionID: "ses_1", id: "msg_stable", prompt: { text: "follow up" } })
    await admitQueue(client, { sessionID: "ses_1", id: "msg_stable", prompt: { text: "follow up" } })

    expect(calls).toEqual([
      { sessionID: "ses_1", id: "msg_stable", prompt: { text: "follow up" }, delivery: "queue", resume: false },
      { sessionID: "ses_1", id: "msg_stable", prompt: { text: "follow up" }, delivery: "queue", resume: false },
    ])
    expect(await pendingInputs(client, "ses_1")).toEqual([])
  })
})
