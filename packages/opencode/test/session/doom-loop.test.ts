import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProcessor } from "@/session/processor"
import { MessageID, PartID, SessionID } from "@/session/schema"

const sessionID = SessionID.create()
const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test")

describe("SessionProcessor.detectDoomLoop", () => {
  test("detects the fourth structurally identical successful probe across assistant messages", () => {
    const messages = [
      user("start"),
      assistant([completed({ query: { a: 1, b: 2 } }, "unchanged", { count: 1 })]),
      assistant([completed({ query: { b: 2, a: 1 } }, "unchanged", { count: 1 })]),
      assistant([completed({ query: { a: 1, b: 2 } }, "unchanged", { count: 1 })]),
    ]
    const current = MessageID.ascending()
    messages.push(assistant([], current))

    expect(
      SessionProcessor.detectDoomLoop({
        messages,
        assistantMessageID: current,
        tool: "status",
        input: { query: { b: 2, a: 1 } },
      }),
    ).toBe("unchanged_success")
  })

  test("does not let a synthetic background notification reset the successful probe history", () => {
    const messages = [
      user("start"),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      user("Background task completed", true),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
    ]
    const current = MessageID.ascending()
    messages.push(assistant([], current))

    expect(
      SessionProcessor.detectDoomLoop({
        messages,
        assistantMessageID: current,
        tool: "status",
        input: { query: "same" },
      }),
    ).toBe("unchanged_success")
  })

  test("does not let compaction or replay records reset the successful probe history", () => {
    const messages = [
      user("start"),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      compactionUser(),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      replayUser(),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
    ]
    const current = MessageID.ascending()
    messages.push(assistant([], current))

    expect(
      SessionProcessor.detectDoomLoop({
        messages,
        assistantMessageID: current,
        tool: "status",
        input: { query: "same" },
      }),
    ).toBe("unchanged_success")
  })

  test("uses MessageID causality instead of compacted array order", () => {
    const messages = [
      user("start"),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
    ]
    const current = MessageID.ascending()
    messages.push(assistant([], current))
    messages.reverse()

    expect(
      SessionProcessor.detectDoomLoop({
        messages,
        assistantMessageID: current,
        tool: "status",
        input: { query: "same" },
      }),
    ).toBe("unchanged_success")
  })

  test("ignores a later admitted steer when guarding an older assistant", () => {
    const start = user("start")
    const first = assistant([completed({ query: "same" }, "unchanged", { count: 1 })])
    const second = assistant([completed({ query: "same" }, "unchanged", { count: 1 })])
    const third = assistant([completed({ query: "same" }, "unchanged", { count: 1 })])
    const current = MessageID.ascending()
    const currentMessage = assistant([], current)
    const later = user("new steer")

    expect(
      SessionProcessor.detectDoomLoop({
        messages: [later, currentMessage, third, start, second, first],
        assistantMessageID: current,
        tool: "status",
        input: { query: "same" },
      }),
    ).toBe("unchanged_success")
  })

  test("does not count terminal outcomes after the guarded assistant", () => {
    const start = user("start")
    const first = assistant([completed({ query: "same" }, "unchanged", { count: 1 })])
    const second = assistant([completed({ query: "same" }, "unchanged", { count: 1 })])
    const current = MessageID.ascending()
    const currentMessage = assistant([], current)
    const later = assistant([completed({ query: "same" }, "unchanged", { count: 1 })])

    expect(
      SessionProcessor.detectDoomLoop({
        messages: [later, second, currentMessage, start, first],
        assistantMessageID: current,
        tool: "status",
        input: { query: "same" },
      }),
    ).toBeUndefined()
  })

  test("resets on a real user message", () => {
    const messages = [
      user("start"),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      assistant([completed({ query: "same" }, "unchanged", { count: 1 })]),
      user("please continue"),
    ]
    const current = MessageID.ascending()
    messages.push(assistant([], current))

    expect(
      SessionProcessor.detectDoomLoop({
        messages,
        assistantMessageID: current,
        tool: "status",
        input: { query: "same" },
      }),
    ).toBeUndefined()
  })

  test.each([
    [
      "output",
      [
        completed({ query: "same" }, "unchanged", { count: 1 }),
        completed({ query: "same" }, "changed", { count: 1 }),
        completed({ query: "same" }, "unchanged", { count: 1 }),
      ],
    ],
    [
      "metadata",
      [
        completed({ query: "same" }, "unchanged", { count: 1 }),
        completed({ query: "same" }, "unchanged", { count: 2 }),
        completed({ query: "same" }, "unchanged", { count: 1 }),
      ],
    ],
    [
      "error",
      [
        completed({ query: "same" }, "unchanged", { count: 1 }),
        failed({ query: "same" }, "failed", { count: 1 }),
        completed({ query: "same" }, "unchanged", { count: 1 }),
      ],
    ],
  ])("resets when a prior %s changes", (_, parts) => {
    const messages = [user("start"), ...parts.map((part) => assistant([part]))]
    const current = MessageID.ascending()
    messages.push(assistant([], current))

    expect(
      SessionProcessor.detectDoomLoop({
        messages,
        assistantMessageID: current,
        tool: "status",
        input: { query: "same" },
      }),
    ).toBeUndefined()
  })

  test("retains the same-message repeated-failure guard", () => {
    const first = user("start")
    const current = MessageID.ascending()
    const messages = [
      first,
      assistant(
        [
          failed({ query: "same" }, "failed", { attempt: 1 }),
          failed({ query: "same" }, "failed", { attempt: 1 }),
          running({ query: "same" }),
        ],
        current,
      ),
    ]

    expect(
      SessionProcessor.detectDoomLoop({
        messages,
        assistantMessageID: current,
        tool: "status",
        input: { query: "same" },
      }),
    ).toBe("repeated_failure")
  })
})

function user(text: string, synthetic = false): SessionV1.WithParts {
  const messageID = MessageID.ascending()
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID, modelID },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID,
        sessionID,
        type: "text",
        text,
        synthetic,
      },
    ],
  }
}

function compactionUser(): SessionV1.WithParts {
  const messageID = MessageID.ascending()
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID, modelID },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID,
        sessionID,
        type: "compaction",
        auto: true,
      },
    ],
  }
}

function replayUser(): SessionV1.WithParts {
  const message = user("replayed user input")
  const part = message.parts[0]
  if (part?.type !== "text") throw new Error("expected replay text")
  part.metadata = { compactionReplay: true }
  return message
}

function assistant(parts: SessionV1.ToolPart[], id = MessageID.ascending()): SessionV1.WithParts {
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      modelID,
      providerID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), completed: Date.now() },
    },
    parts,
  }
}

function completed(input: Record<string, unknown>, output: string, metadata: Record<string, unknown>) {
  return tool({ status: "completed", input, output, metadata, title: "status", time: { start: 1, end: 2 } })
}

function failed(input: Record<string, unknown>, error: string, metadata: Record<string, unknown>) {
  return tool({ status: "error", input, error, metadata, time: { start: 1, end: 2 } })
}

function running(input: Record<string, unknown>) {
  return tool({ status: "running", input, time: { start: 1 } })
}

function tool(state: SessionV1.ToolPart["state"]): SessionV1.ToolPart {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID,
    type: "tool",
    callID: crypto.randomUUID(),
    tool: "status",
    state,
  }
}
