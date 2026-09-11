import { describe, expect, test } from "bun:test"
import { hasCustomAgent, isAgentSelectorVisible, resolveAgent } from "./local-agent"

describe("hasCustomAgent", () => {
  test("detects explicitly custom agents", () => {
    expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  })

  test("ignores built-in and unclassified agents", () => {
    expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
  })
})

describe("isAgentSelectorVisible", () => {
  test("returns true if setting preference is enabled", () => {
    expect(isAgentSelectorVisible(true, [{ native: true }])).toBe(true)
  })

  test("returns true if custom agents exist", () => {
    expect(isAgentSelectorVisible(false, [{ native: true }, { native: false }])).toBe(true)
  })

  test("returns true if multiple agents exist (e.g. build and plan)", () => {
    expect(isAgentSelectorVisible(false, [{ native: true }, { native: true }])).toBe(true)
  })

  test("returns false if only 1 native agent exists and preference is disabled", () => {
    expect(isAgentSelectorVisible(false, [{ native: true }])).toBe(false)
  })
})

describe("resolveAgent", () => {
  const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

  test("uses the requested available agent", () => {
    expect(resolveAgent(agents, "custom")?.name).toBe("custom")
  })

  test("defaults to build", () => {
    expect(resolveAgent(agents)?.name).toBe("build")
    expect(resolveAgent(agents, "missing")?.name).toBe("build")
  })

  test("uses the first agent when build is unavailable", () => {
    expect(resolveAgent([{ name: "custom" }], "missing")?.name).toBe("custom")
  })
})
