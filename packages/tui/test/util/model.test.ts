import { describe, expect, test } from "bun:test"
import { label, parse } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("appends only persisted non-default variants", () => {
    expect(label(undefined, "openai", "gpt-5.6-sol", "max")).toBe("gpt-5.6-sol · max")
    expect(label(undefined, "openai", "gpt-5.6-sol", "default")).toBe("gpt-5.6-sol")
    expect(label(undefined, "openai", "gpt-5.6-sol")).toBe("gpt-5.6-sol")
  })
})
