import { describe, expect, test } from "bun:test"
import { isDefaultTitle, isSessionInterruptible } from "../../src/util/session"

describe("util.session", () => {
  test("recognizes generated parent and child titles", () => {
    expect(isDefaultTitle("New session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("Child session - 2026-06-06T12:34:56.789Z")).toBeTrue()
    expect(isDefaultTitle("New session - custom")).toBeFalse()
  })

  test("interrupts a session while any owned work is active", () => {
    const sessions = [
      { id: "root" },
      { id: "child", parentID: "root" },
      { id: "grandchild", parentID: "child" },
      { id: "other" },
    ]

    expect(isSessionInterruptible("root", sessions, { root: { type: "busy" } })).toBeTrue()
    expect(isSessionInterruptible("root", sessions, { child: { type: "busy" } })).toBeTrue()
    expect(isSessionInterruptible("root", sessions, { grandchild: { type: "retry", attempt: 1, message: "", next: 0 } }))
      .toBeTrue()
    expect(isSessionInterruptible("root", sessions, { other: { type: "busy" } })).toBeFalse()
    expect(isSessionInterruptible("root", sessions, { child: { type: "idle" } })).toBeFalse()
    expect(isSessionInterruptible("root", sessions, {})).toBeFalse()
  })
})
