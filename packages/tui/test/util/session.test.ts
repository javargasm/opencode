import { describe, expect, test } from "bun:test"
import {
  getActiveDescendantCount,
  getSessionActivity,
  isDefaultTitle,
  isSessionActivityActive,
  sessionActivityLabel,
} from "../../src/util/session"

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })

  test("distinguishes current work from nested descendant work", () => {
    const sessions = [
      { id: "root" },
      { id: "child", parentID: "root" },
      { id: "grandchild", parentID: "child" },
      { id: "other" },
    ]

    expect(getSessionActivity("root", sessions, { root: { type: "busy" } })).toBe("current")
    expect(getSessionActivity("root", sessions, { root: { type: "retry", attempt: 1, message: "", next: 0 } })).toBe(
      "current",
    )
    expect(getSessionActivity("root", sessions, { child: { type: "busy" } })).toBe("descendant")
    expect(
      getSessionActivity("root", sessions, {
        grandchild: { type: "retry", attempt: 1, message: "", next: 0 },
      }),
    ).toBe("descendant")
    expect(getSessionActivity("root", sessions, { other: { type: "busy" } })).toBe("idle")
    expect(getSessionActivity("root", sessions, { child: { type: "idle" } })).toBe("idle")
    expect(getSessionActivity("root", sessions, {})).toBe("idle")
    expect(getSessionActivity(undefined, sessions, { child: { type: "busy" } })).toBe("idle")
  })

  test("terminates cyclic ancestry without inventing descendant activity", () => {
    const sessions = [{ id: "root" }, { id: "cycle-a", parentID: "cycle-b" }, { id: "cycle-b", parentID: "cycle-a" }]

    expect(getSessionActivity("root", sessions, { "cycle-a": { type: "busy" } })).toBe("idle")
    expect(getActiveDescendantCount("root", sessions, { "cycle-a": { type: "busy" } })).toBe(0)
  })

  test("counts every active descendant and excludes idle and unrelated sessions", () => {
    const sessions = [
      { id: "root" },
      { id: "child", parentID: "root" },
      { id: "grandchild", parentID: "child" },
      { id: "idle-child", parentID: "root" },
      { id: "other" },
    ]

    expect(
      getActiveDescendantCount("root", sessions, {
        child: { type: "busy" },
        grandchild: { type: "retry", attempt: 1, message: "", next: 0 },
        "idle-child": { type: "idle" },
        other: { type: "busy" },
      }),
    ).toBe(2)
  })

  test("keeps current and descendant activity active", () => {
    expect(isSessionActivityActive("current")).toBeTrue()
    expect(isSessionActivityActive("descendant")).toBeTrue()
    expect(isSessionActivityActive("idle")).toBeFalse()
  })

  test("keeps active descendants visible independently of parent activity", () => {
    expect(sessionActivityLabel("descendant", 2)).toBe("↳ Subagent active(2)")
    expect(sessionActivityLabel("current", 2)).toBe("↳ Subagent active(2)")
    expect(sessionActivityLabel("current", 0)).toBeUndefined()
    expect(sessionActivityLabel("idle", 0)).toBeUndefined()
  })
})
