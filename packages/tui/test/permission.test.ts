import { describe, expect, test } from "bun:test"
import { doomLoopPermissionCopy } from "../src/routes/session/permission"

describe("doom-loop permission copy", () => {
  test("distinguishes unchanged success from failure and legacy requests", () => {
    expect(doomLoopPermissionCopy("unchanged_success")).toEqual({
      title: "Continue after identical results",
      description: "The tool returned the same result repeatedly. Continuing may loop.",
    })
    for (const reason of ["repeated_failure", undefined]) {
      expect(doomLoopPermissionCopy(reason)).toEqual({
        title: "Continue after repeated failures",
        description: "This keeps the session running despite repeated failures.",
      })
    }
  })
})
