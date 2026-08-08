import { describe, expect, test } from "bun:test"
import { RGBA, type CapturedSpan } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ActiveDescendantLabel, AnimatedActivityLabel } from "../../src/component/animated-activity-label"
import { getActiveDescendantCount, getSessionActivity } from "../../src/util/session"

const label = "↳ Subagent active(2)"
const color = RGBA.fromHex("#ff6600")
const mutedColor = RGBA.fromHex("#777777")
const sessions = [{ id: "root" }, { id: "child", parentID: "root" }, { id: "grandchild", parentID: "child" }]

describe("AnimatedActivityLabel", () => {
  test("keeps the exact label visible while its color scan advances", async () => {
    const app = await testRender(
      () => <AnimatedActivityLabel label={label} color={color} mutedColor={mutedColor} animated />,
      { width: label.length, height: 1 },
    )

    try {
      await app.renderOnce()
      const before = app.captureSpans().lines[0]?.spans ?? []
      expect(app.captureCharFrame().split("\n")[0]).toBe(label)
      expect(before.length).toBeGreaterThan(1)

      await Bun.sleep(55)
      await app.renderOnce()

      const after = app.captureSpans().lines[0]?.spans ?? []
      expect(app.captureCharFrame().split("\n")[0]).toBe(label)
      expect(after.map((span) => span.text)).not.toEqual(before.map((span) => span.text))
      expect(spanSignature(after)).not.toBe(spanSignature(before))
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the label visible without animation", async () => {
    const app = await testRender(
      () => <AnimatedActivityLabel label={label} color={color} mutedColor={mutedColor} animated={false} />,
      { width: label.length, height: 1 },
    )

    try {
      await app.renderOnce()
      expect(app.captureCharFrame().split("\n")[0]).toBe(label)
    } finally {
      app.renderer.destroy()
    }
  })
})

describe("ActiveDescendantLabel", () => {
  test("renders direct and nested descendants while the parent is busy", async () => {
    const result = await renderActiveDescendantLabel({
      root: { type: "busy" },
      child: { type: "busy" },
      grandchild: { type: "retry", attempt: 1, message: "", next: 0 },
    })

    expect(result.activity).toBe("current")
    expect(result.count).toBe(2)
    expect(result.frame).toBe(label)
  })

  test("stays hidden while the parent is busy without active descendants", async () => {
    const result = await renderActiveDescendantLabel({ root: { type: "busy" } })

    expect(result.activity).toBe("current")
    expect(result.count).toBe(0)
    expect(result.frame.trim()).toBe("")
  })

  test("preserves descendant-only activity", async () => {
    const result = await renderActiveDescendantLabel({
      child: { type: "busy" },
      grandchild: { type: "retry", attempt: 1, message: "", next: 0 },
    })

    expect(result.activity).toBe("descendant")
    expect(result.count).toBe(2)
    expect(result.frame).toBe(label)
  })
})

function spanSignature(spans: CapturedSpan[]) {
  return spans.map((span) => `${span.text}:${span.fg.r},${span.fg.g},${span.fg.b},${span.fg.a}`).join("|")
}

async function renderActiveDescendantLabel(statuses: Parameters<typeof getSessionActivity>[2]) {
  const activity = getSessionActivity("root", sessions, statuses)
  const count = getActiveDescendantCount("root", sessions, statuses)
  const app = await testRender(
    () => (
      <ActiveDescendantLabel
        activity={activity}
        activeDescendantCount={count}
        color={color}
        mutedColor={mutedColor}
        animated={false}
      />
    ),
    { width: label.length, height: 1 },
  )

  try {
    await app.renderOnce()
    return {
      activity,
      count,
      frame: app.captureCharFrame().split("\n")[0] ?? "",
    }
  } finally {
    app.renderer.destroy()
  }
}
