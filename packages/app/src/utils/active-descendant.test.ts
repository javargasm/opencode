import { describe, expect, test } from "bun:test"
import { getActiveDescendantCount, sessionActivityLabel } from "./active-descendant"
import type { SessionStatus } from "@opencode-ai/sdk/v2"

describe("getActiveDescendantCount", () => {
  test("returns 0 when sessionID is undefined or no sessions exist", () => {
    expect(getActiveDescendantCount(undefined, [], {})).toBe(0)
    expect(getActiveDescendantCount("ses_root", [], {})).toBe(0)
  })

  test("counts direct active children", () => {
    const sessions = [
      { id: "ses_root", parentID: undefined },
      { id: "ses_sub1", parentID: "ses_root" },
      { id: "ses_sub2", parentID: "ses_root" },
      { id: "ses_sub3", parentID: "ses_root" },
    ]
    const statuses: Record<string, SessionStatus> = {
      ses_sub1: { type: "busy" },
      ses_sub2: { type: "idle" },
      ses_sub3: { type: "busy" },
    }

    expect(getActiveDescendantCount("ses_root", sessions, statuses)).toBe(2)
  })

  test("counts nested descendant subagents recursively", () => {
    const sessions = [
      { id: "ses_root", parentID: undefined },
      { id: "ses_child", parentID: "ses_root" },
      { id: "ses_grandchild", parentID: "ses_child" },
      { id: "ses_sibling", parentID: "ses_root" },
    ]
    const statuses: Record<string, SessionStatus> = {
      ses_child: { type: "idle" },
      ses_grandchild: { type: "busy" },
      ses_sibling: { type: "busy" },
    }

    expect(getActiveDescendantCount("ses_root", sessions, statuses)).toBe(2)
    expect(getActiveDescendantCount("ses_child", sessions, statuses)).toBe(1)
    expect(getActiveDescendantCount("ses_grandchild", sessions, statuses)).toBe(0)
  })

  test("counts only strict descendants in a reachable root-child cycle", () => {
    const sessions = [
      { id: "ses_root", parentID: "ses_child" },
      { id: "ses_child", parentID: "ses_root" },
    ]
    const statuses: Record<string, SessionStatus> = {
      ses_root: { type: "busy" },
      ses_child: { type: "busy" },
    }

    expect(getActiveDescendantCount("ses_root", sessions, statuses)).toBe(1)
  })

  test("avoids infinite loops on circular parent references", () => {
    const sessions = [
      { id: "ses_1", parentID: "ses_2" },
      { id: "ses_2", parentID: "ses_1" },
    ]
    const statuses: Record<string, SessionStatus> = {
      ses_1: { type: "busy" },
      ses_2: { type: "busy" },
    }

    expect(getActiveDescendantCount("ses_root", sessions, statuses)).toBe(0)
  })
})

describe("sessionActivityLabel", () => {
  test("returns undefined for 0", () => {
    expect(sessionActivityLabel(0)).toBeUndefined()
    expect(sessionActivityLabel(-1)).toBeUndefined()
  })

  test("formats singular and plural correctly", () => {
    expect(sessionActivityLabel(1)).toBe("1 subagent active")
    expect(sessionActivityLabel(3)).toBe("3 subagents active")
  })
})
