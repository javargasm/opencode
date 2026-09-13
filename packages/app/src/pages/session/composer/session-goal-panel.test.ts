import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"

type Goal = {
  sessionID: string
  objective: string
  status: "active" | "paused" | "blocked" | "complete"
  reason?: string
  updatedAt: number
}

type MountedGoalPanel = {
  dispose: () => void
  setSessionID: (value: string) => void
  setGoal: (value: Goal) => void
}

const appDirectory = resolve(import.meta.dir, "../../../..")
let directory: string
let mount: (onSave: () => Promise<Goal>) => MountedGoalPanel

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "opencode-session-goal-panel-"))
  const entry = join(directory, "entry.ts")
  await Bun.write(
    entry,
    [
      'import { createComponent, createSignal } from "solid-js"',
      'import { render } from "solid-js/web"',
      `import { SessionGoalPanel } from ${JSON.stringify(join(appDirectory, "src/pages/session/composer/session-goal-panel.tsx"))}`,
      "",
      "export function mount(onSave) {",
      '  const [sessionID, setSessionID] = createSignal("ses_a")',
      '  const [goal, setGoal] = createSignal({ sessionID: "ses_a", objective: "goal A", status: "active", updatedAt: 1 })',
      "  const dispose = render(() => createComponent(SessionGoalPanel, { sessionID, goal, onSave }), document.body)",
      "  return { dispose, setSessionID, setGoal }",
      "}",
    ].join("\n"),
  )
  await build({
    root: appDirectory,
    configFile: false,
    logLevel: "silent",
    resolve: {
      alias: [
        {
          find: "solid-js/web",
          replacement: join(appDirectory, "node_modules/solid-js/web"),
        },
        {
          find: "solid-js",
          replacement: join(appDirectory, "node_modules/solid-js"),
        },
      ],
    },
    plugins: [
      solid(),
      {
        name: "session-goal-panel-test-mocks",
        resolveId(id) {
          if (id === "@/context/language") return "\0session-goal-panel-test-language"
          if (id === "@opencode-ai/ui/button") return "\0session-goal-panel-test-button"
        },
        load(id) {
          if (id === "\0session-goal-panel-test-language") {
            return 'export function useLanguage() { return { t: (key) => key } }'
          }
          if (id === "\0session-goal-panel-test-button") {
            return [
              'import { createEffect } from "solid-js"',
              "",
              "export function Button(props) {",
              '  const button = document.createElement("button")',
              "  button.onclick = props.onClick ?? null",
              "  createEffect(() => {",
              "    button.disabled = props.disabled ?? false",
              '    button.textContent = String(typeof props.children === "function" ? props.children() : props.children ?? "")',
              "  })",
              "  return button",
              "}",
            ].join("\n")
          }
        },
      },
    ],
    build: {
      emptyOutDir: true,
      lib: {
        entry,
        formats: ["es"],
        fileName: "component",
      },
      outDir: join(directory, "dist"),
    },
  })
  ;({ mount } = await import(pathToFileURL(join(directory, "dist/component.js")).href))
})

afterEach(() => {
  document.body.replaceChildren()
})

afterAll(async () => {
  await rm(directory, { force: true, recursive: true })
})

describe("SessionGoalPanel", () => {
  test("keeps the current session goal and save state after a stale save resolves", async () => {
    let releaseFirst!: (goal: Goal) => void
    let releaseSecond!: (goal: Goal) => void
    const first = new Promise<Goal>((resolve) => {
      releaseFirst = resolve
    })
    const second = new Promise<Goal>((resolve) => {
      releaseSecond = resolve
    })
    let saves = 0
    const panel = mount(() => {
      saves++
      if (saves === 1) return first
      return second
    })

    await Promise.resolve()
    const textarea = document.querySelector("textarea")!
    textarea.value = "edited A"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    const button = document.querySelector("button")!
    button.click()

    panel.setSessionID("ses_b")
    panel.setGoal({
      sessionID: "ses_b",
      objective: "goal B",
      status: "active",
      updatedAt: 2,
    })
    await Promise.resolve()
    button.click()
    expect(saves).toBe(2)
    expect(button.disabled).toBe(true)

    releaseFirst({
      sessionID: "ses_a",
      objective: "edited A",
      status: "active",
      updatedAt: 3,
    })
    await Promise.resolve()

    expect(textarea.value).toBe("goal B")
    expect(button.disabled).toBe(true)
    releaseSecond({
      sessionID: "ses_b",
      objective: "goal B",
      status: "active",
      updatedAt: 4,
    })
    await Promise.resolve()
    panel.dispose()
  })
})
