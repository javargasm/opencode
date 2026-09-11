import { describe, expect, test } from "bun:test"
import type { SessionApi } from "@opencode-ai/client/promise"
import type { OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "@/context/server-session"
import type { ServerApi } from "@/utils/server"
import { loadTimelineHistory, timelineTurnText } from "./dialog-timeline"

type FilePart = Extract<Part, { type: "file" }>
type AgentPart = Extract<Part, { type: "agent" }>
type TextPart = Extract<Part, { type: "text" }>

describe("DialogTimeline", () => {
  test("loads every available history page for the active session", async () => {
    const turns = Array.from({ length: 30 }, (_, index) => {
      const turn = index + 1
      const time = 1_700_000_000_000 + index * 2
      return [
        {
          id: `user_${turn}`,
          type: "user" as const,
          text: `turn ${turn}`,
          time: { created: time },
        },
        {
          id: `assistant_${turn}`,
          type: "assistant" as const,
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [{ type: "text" as const, text: `answer ${turn}` }],
          time: { created: time + 1, completed: time + 1 },
        },
      ]
    }).flat()
    const requests: unknown[] = []
    const messageApi = {
      list: async (input: unknown) => {
        requests.push(input)
        const request = input as { cursor?: string }
        if (request.cursor) return { data: turns.slice(0, -20).toReversed(), cursor: { previous: null, next: null } }
        return { data: turns.slice(-20).toReversed(), cursor: { previous: null, next: "older-1" } }
      },
    } as unknown as ServerApi["message"]
    const store = createServerSession({} as OpencodeClient, {} as SessionApi, messageApi)
    store.remember({
      id: "ses_root",
      slug: "root",
      projectID: "project",
      directory: "/repo",
      title: "root",
      version: "1",
      time: { created: 1, updated: 1 },
    } as Session)

    await store.sync("ses_root")
    await loadTimelineHistory({
      sessionID: () => "ses_root",
      history: store.history,
    })

    expect(requests).toEqual([
      { sessionID: "ses_root", limit: 20, order: "desc" },
      { sessionID: "ses_root", limit: 200, cursor: "older-1" },
    ])
    expect(store.data.message.ses_root).toHaveLength(60)
    expect(store.data.message.ses_root.filter((message) => message.role === "user")).toHaveLength(30)
    expect(store.data.message.ses_root.find((message) => message.role === "user")?.id).toBe("user_1")
    expect(store.history.more("ses_root")).toBe(false)
  })

  test("stops loading when the dialog is no longer active", async () => {
    let remaining = 2
    let active = true

    await loadTimelineHistory({
      sessionID: () => "ses_root",
      active: () => active,
      history: {
        more: () => remaining > 0,
        loading: () => false,
        loadMore: async () => {
          remaining -= 1
          active = false
        },
      },
    })

    expect(remaining).toBe(1)
  })

  test("represents attachment-only and agent-only prompts", () => {
    const attachment = {
      id: "prt_file",
      sessionID: "ses_root",
      messageID: "msg_attachment",
      type: "file",
      mime: "text/plain",
      filename: "notes.txt",
      url: "data:text/plain;base64,SGVsbG8=",
    } as FilePart
    const agent = {
      id: "prt_agent",
      sessionID: "ses_root",
      messageID: "msg_agent",
      type: "agent",
      name: "build",
    } as AgentPart

    expect(timelineTurnText([attachment], "Attachment")).toBe("notes.txt")
    expect(timelineTurnText([agent], "Attachment")).toBe("@build")
    expect(timelineTurnText([{ ...attachment, filename: "   " }], "Attachment")).toBe("Attachment")
    expect(timelineTurnText([{ ...agent, source: { value: "   ", start: 0, end: 3 } }], "Attachment")).toBe("@build")
  })

  test("keeps prompt text as the timeline label when attachments are present", () => {
    const text = {
      id: "prt_text",
      sessionID: "ses_root",
      messageID: "msg_text",
      type: "text",
      text: "Review this file",
    } as TextPart
    const attachment = {
      id: "prt_file",
      sessionID: "ses_root",
      messageID: "msg_text",
      type: "file",
      mime: "text/plain",
      filename: "notes.txt",
      url: "data:text/plain;base64,SGVsbG8=",
    } as FilePart

    expect(timelineTurnText([text, attachment], "Attachment")).toBe("Review this file")
  })
})
