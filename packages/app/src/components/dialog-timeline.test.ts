import { afterEach, describe, expect, test } from "bun:test"
import { findTimelineMessageElement } from "./dialog-timeline"

describe("findTimelineMessageElement", () => {
  afterEach(() => document.body.replaceChildren())

  test("matches data-message-id values exactly without parsing them as selectors", () => {
    const root = document.createElement("div")
    const unrelated = document.createElement("div")
    unrelated.setAttribute("data-message-id", "msg_target")
    const expected = document.createElement("div")
    const id = 'msg_bad"], [data-message-id="msg_target'
    expected.setAttribute("data-message-id", id)
    root.append(unrelated, expected)
    document.body.append(root)

    expect(() => findTimelineMessageElement(root, id)).not.toThrow()
    expect(findTimelineMessageElement(root, id)).toBe(expected)
  })

  test("returns the first exact match", () => {
    const root = document.createElement("div")
    const first = document.createElement("div")
    const second = document.createElement("div")
    first.setAttribute("data-message-id", "msg_duplicate")
    second.setAttribute("data-message-id", "msg_duplicate")
    root.append(first, second)

    expect(findTimelineMessageElement(root, "msg_duplicate")).toBe(first)
  })
})
