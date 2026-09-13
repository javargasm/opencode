import { describe, expect, test } from "bun:test"
import { resolveSidecarVersion } from "./sidecar-version"

describe("resolveSidecarVersion", () => {
  test("uses V2 by default for the dev channel", () => {
    expect(resolveSidecarVersion("dev", false, undefined)).toBe("v2")
  })

  test("keeps non-dev channels on V1 unless explicitly enabled", () => {
    expect(resolveSidecarVersion("beta", false, undefined)).toBe("v1")
    expect(resolveSidecarVersion("prod", false, "1")).toBe("v2")
  })

  test("uses V2 when the build bundles the source CLI", () => {
    expect(resolveSidecarVersion("prod", true, undefined)).toBe("v2")
  })

  test("allows an explicit V1 escape hatch", () => {
    expect(resolveSidecarVersion("dev", true, "0")).toBe("v1")
  })
})
