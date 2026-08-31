import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { SPINNER_FRAMES } from "../src/component/spinner"
import { tmpdir } from "./fixture/fixture"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

async function waitForFrame(setup: Awaited<ReturnType<typeof createTestRenderer>>, check: (frame: string) => boolean) {
  const end = Date.now() + 2_000
  while (Date.now() < end) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (check(frame)) return frame
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for frame")
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("standard Shell uses Thinking, its fallback, and no loader after completion", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const setup = await createTestRenderer({ width: 100, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "root",
    title: "Shell loader",
    slug: "root",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const info = {
    id: "msg-1",
    sessionID: session.id,
    role: "assistant" as const,
    time: { created: 1 },
    parentID: "msg-user-1",
    modelID: "gpt-5",
    providerID: "openai",
    mode: "chat",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const part = {
    id: "bash-1",
    sessionID: session.id,
    messageID: info.id,
    type: "tool" as const,
    callID: "call-bash-1",
    tool: "bash",
    state: {
      status: "running" as const,
      input: { command: "sleep 25m" },
      metadata: { output: "" },
      time: { start: 1 },
    },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([session])
    if (url.pathname === `/session/${session.id}`) return json(session)
    if (url.pathname === `/session/${session.id}/message`) return json([{ info, parts: [part] }])
    if (url.pathname === `/session/${session.id}/todo` || url.pathname === `/session/${session.id}/diff`)
      return json([])
  })
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let task: Promise<void> | undefined

  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(Global.layerWith({ state: tmp.path }))),
    )
    await ready

    const active = await waitForFrame(setup, (frame) => frame.includes("$ sleep 25m"))
    const activeLine = active.split("\n").find((line) => line.includes("$ sleep 25m")) ?? ""
    expect(SPINNER_FRAMES.some((icon) => activeLine.includes(`${icon} $ sleep 25m`))).toBe(true)

    api?.keymap.dispatchCommand("app.toggle.animations")
    const fallback = await waitForFrame(setup, (frame) => frame.includes("⋯ $ sleep 25m"))
    expect(fallback).toContain("⋯ $ sleep 25m")

    events.emit({
      directory,
      project: "proj_test",
      payload: {
        id: "evt-bash-completed",
        type: "message.part.updated",
        properties: {
          sessionID: session.id,
          time: 2,
          part: {
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              output: "",
              title: "",
              metadata: part.state.metadata,
              time: { start: 1, end: 2 },
            },
          },
        },
      },
    } satisfies GlobalEvent)
    const terminal = await waitForFrame(setup, (frame) => {
      const line = frame.split("\n").find((item) => item.includes("$ sleep 25m")) ?? ""
      return Boolean(line) && !line.includes("⋯ $ sleep 25m")
    })
    const terminalLine = terminal.split("\n").find((line) => line.includes("$ sleep 25m")) ?? ""
    expect(terminalLine).not.toContain("⋯ $ sleep 25m")
    expect(SPINNER_FRAMES.some((icon) => terminalLine.includes(`${icon} $ sleep 25m`))).toBe(false)

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) {
      api?.keymap.dispatchCommand("app.exit")
      await task?.catch(() => {})
      setup.renderer.destroy()
    }
    mock.restore()
  }
})
