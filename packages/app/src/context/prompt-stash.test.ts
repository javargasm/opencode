import { describe, expect, test } from "bun:test"
import { hasStashablePrompt, MAX_STASH_ENTRIES } from "./prompt-stash"

describe("prompt-stash", () => {
  test("MAX_STASH_ENTRIES is 50", () => {
    expect(MAX_STASH_ENTRIES).toBe(50)
  })

  test("accepts attachment-only prompts while rejecting empty text", () => {
    expect(hasStashablePrompt([{ type: "text", content: "  ", start: 0, end: 2 }])).toBe(false)
    expect(
      hasStashablePrompt([
        {
          type: "image",
          id: "image",
          filename: "guide.pdf",
          mime: "application/pdf",
          blob: { id: "blob", url: "blob:guide" },
        },
      ]),
    ).toBe(true)
    expect(hasStashablePrompt([{ type: "file", path: "/tmp/guide.md", content: "", start: 0, end: 0 }])).toBe(true)
    expect(hasStashablePrompt([{ type: "agent", name: "build", content: "", start: 0, end: 0 }])).toBe(true)
  })
})
