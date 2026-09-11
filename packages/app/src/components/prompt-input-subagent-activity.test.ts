import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2"
import { getPromptInputActiveSubagentCount } from "./prompt-input"
import { getPromptInputV2ActiveSubagentCount } from "./prompt-input-v2"

const implementations = [
  ["legacy prompt input", getPromptInputActiveSubagentCount],
  ["v2 prompt input", getPromptInputV2ActiveSubagentCount],
] as const

describe("prompt input subagent activity", () => {
  for (const [name, getCount] of implementations) {
    test(`${name} ignores active subagents outside the current session tree`, () => {
      const sessions = [
        { id: "ses_current", parentID: undefined },
        { id: "ses_other_root", parentID: undefined },
        { id: "ses_other_child", parentID: "ses_other_root" },
      ]
      const statuses: Record<string, SessionStatus> = {
        ses_other_child: { type: "busy" },
      }

      expect(getCount("ses_current", sessions, statuses)).toBe(0)
    })

    test(`${name} continues to count active descendants of the current session`, () => {
      const sessions = [
        { id: "ses_current", parentID: undefined },
        { id: "ses_current_child", parentID: "ses_current" },
        { id: "ses_other_root", parentID: undefined },
        { id: "ses_other_child", parentID: "ses_other_root" },
      ]
      const statuses: Record<string, SessionStatus> = {
        ses_current_child: { type: "busy" },
        ses_other_child: { type: "busy" },
      }

      expect(getCount("ses_current", sessions, statuses)).toBe(1)
    })
  }

  test("v2 falls back to global activity only when no session exists", () => {
    const sessions = [
      { id: "ses_other_root", parentID: undefined },
      { id: "ses_other_child", parentID: "ses_other_root" },
    ]
    const statuses: Record<string, SessionStatus> = {
      ses_other_child: { type: "busy" },
    }

    expect(getPromptInputV2ActiveSubagentCount(undefined, sessions, statuses)).toBe(1)
  })
})
