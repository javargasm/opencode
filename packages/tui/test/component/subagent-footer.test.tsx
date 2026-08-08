/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { AssistantMessage, Provider, Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { RouteProvider, useRoute, type RouteContext } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncContext, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { SubagentFooter } from "../../src/routes/session/subagent-footer"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

test("renders Stop after context and interrupts the viewed subagent on the second Escape", async () => {
  await using tmp = await tmpdir()
  const footer = await mountFooter(tmp.path, { "child-3": { type: "busy" } })

  try {
    expect(footer.frame()).toContain("Subagent (3 of 3) 51.7K (5%) Stop")

    footer.app.mockInput.pressEscape()
    await Bun.sleep(0)
    expect(footer.aborts).toEqual([])

    footer.app.mockInput.pressEscape()
    await waitFor(() => footer.aborts.length === 1)
    expect(footer.aborts).toEqual(["child-3"])
    expect(footer.aborts).not.toContain("root")
  } finally {
    footer.app.renderer.destroy()
  }
})

test("clicking Stop interrupts the viewed subagent once", async () => {
  await using tmp = await tmpdir()
  const footer = await mountFooter(tmp.path, { "child-3": { type: "busy" } })

  try {
    const lines = footer.frame().split("\n")
    const y = lines.findIndex((line) => line.includes("Stop"))
    const x = lines[y]?.indexOf("Stop") ?? -1
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)

    await footer.app.mockMouse.click(x, y)
    await waitFor(() => footer.aborts.length === 1)
    expect(footer.aborts).toEqual(["child-3"])
  } finally {
    footer.app.renderer.destroy()
  }
})

test("enables interruption for descendant-only activity and hides it for an idle subtree", async () => {
  await using activeTmp = await tmpdir()
  const active = await mountFooter(activeTmp.path, {
    "child-3": { type: "idle" },
    grandchild: { type: "busy" },
  })

  try {
    expect(active.frame()).toContain("Stop")
    active.app.mockInput.pressEscape()
    active.app.mockInput.pressEscape()
    await waitFor(() => active.aborts.length === 1)
    expect(active.aborts).toEqual(["child-3"])
  } finally {
    active.app.renderer.destroy()
  }

  await using idleTmp = await tmpdir()
  const idle = await mountFooter(idleTmp.path, {
    "child-3": { type: "idle" },
    grandchild: { type: "idle" },
  })

  try {
    expect(idle.frame()).not.toContain("Stop")
    idle.app.mockInput.pressEscape()
    idle.app.mockInput.pressEscape()
    await Bun.sleep(10)
    expect(idle.aborts).toEqual([])
  } finally {
    idle.app.renderer.destroy()
  }
})

test("scopes Escape confirmation to the viewed subagent across navigation", async () => {
  await using tmp = await tmpdir()
  const footer = await mountFooter(tmp.path, {
    "child-2": { type: "busy" },
    "child-3": { type: "busy" },
  })

  try {
    footer.app.mockInput.pressEscape()
    footer.route.navigate({ type: "session", sessionID: "child-2" })
    await footer.app.renderOnce()

    footer.app.mockInput.pressEscape()
    await Bun.sleep(0)
    expect(footer.aborts).toEqual([])

    footer.app.mockInput.pressEscape()
    await waitFor(() => footer.aborts.length === 1)
    expect(footer.aborts).toEqual(["child-2"])
  } finally {
    footer.app.renderer.destroy()
  }
})

async function mountFooter(root: string, statuses: Record<string, SessionStatus>) {
  await mkdir(path.join(root, "state"), { recursive: true })
  await Bun.write(path.join(root, "state", "kv.json"), "{}")

  const sessions = [
    session("root", undefined, 0),
    session("child-1", "root", 1),
    session("child-2", "root", 2),
    session("child-3", "root", 3),
    session("grandchild", "child-3", 4),
  ]
  const aborts: string[] = []
  const calls = createFetch((url) => {
    const match = url.pathname.match(/^\/session\/([^/]+)\/abort$/)
    if (!match) return
    aborts.push(decodeURIComponent(match[1]))
    return json(true)
  })
  const sync = {
    data: {
      message: { "child-3": [assistantMessage()] },
      provider: [provider()],
      session: sessions,
      session_status: statuses,
    },
    session: {
      get(sessionID: string) {
        return sessions.find((item) => item.id === sessionID)
      },
    },
  } as unknown as ReturnType<typeof useSync>
  let route!: RouteContext

  function Footer() {
    route = useRoute()
    return <SubagentFooter />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts directory={directory} paths={{ home: root, state: path.join(root, "state"), worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                <SDKProvider url="http://test" directory={directory} events={eventSource()} fetch={calls.fetch}>
                  <RouteProvider initialRoute={{ type: "session", sessionID: "child-3" }}>
                    <SyncContext.Provider value={sync}>
                      <Footer />
                    </SyncContext.Provider>
                  </RouteProvider>
                </SDKProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 100, height: 5, kittyKeyboard: true })
  for (let attempt = 0; attempt < 5; attempt++) {
    await app.renderOnce()
    if (app.captureCharFrame().includes("Subagent")) break
    await Bun.sleep(25)
  }
  return {
    app,
    aborts,
    get route() {
      return route
    },
    frame: () => app.captureCharFrame(),
  }
}

function session(id: string, parentID: string | undefined, created: number): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory,
    parentID,
    title: "Child session",
    version: "1",
    cost: 0,
    time: { created, updated: created },
  }
}

function assistantMessage(): AssistantMessage {
  return {
    id: "message",
    sessionID: "child-3",
    role: "assistant",
    parentID: "parent-message",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 50_000, output: 1_700, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, completed: 1 },
  }
}

function provider() {
  return {
    id: "provider",
    models: { model: { limit: { context: 1_000_000 } } },
  } as unknown as Provider
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for condition")
}
