/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { Prompt } from "../../src/component/prompt"
import { TuiConfigProvider } from "../../src/config"
import { ArgsProvider } from "../../src/context/args"
import { ClipboardProvider } from "../../src/context/clipboard"
import { DataProvider } from "../../src/context/data"
import { EditorContextProvider } from "../../src/context/editor"
import { ExitProvider } from "../../src/context/exit"
import { KVProvider } from "../../src/context/kv"
import { LocalProvider } from "../../src/context/local"
import { LocationProvider } from "../../src/context/location"
import { PermissionProvider } from "../../src/context/permission"
import { ProjectProvider } from "../../src/context/project"
import { RouteProvider } from "../../src/context/route"
import { SDKProvider } from "../../src/context/sdk"
import { SyncProvider, useSync } from "../../src/context/sync"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { FrecencyProvider } from "../../src/prompt/frecency"
import { PromptHistoryProvider } from "../../src/prompt/history"
import { PromptStashProvider } from "../../src/prompt/stash"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createFetch, directory, eventSource, json } from "../fixture/tui-sdk"

const label = "↳ Subagent active(2)"
const sessions = [session("child", "root", 1), session("grandchild", "child", 2), session("root", undefined, 0)]

describe("Prompt activity footer", () => {
  test("renders active descendants while the root is busy", async () => {
    await using tmp = await tmpdir()
    const prompt = await mountPrompt(tmp.path, {
      root: { type: "busy" },
      child: { type: "busy" },
      grandchild: { type: "retry", attempt: 1, message: "", next: 0 },
    })

    try {
      expect(prompt.frame).toContain(label)
      expect(occurrences(prompt.frame, label)).toBe(1)
    } finally {
      prompt.app.renderer.destroy()
    }
  })

  test("omits descendant activity while the root is busy alone", async () => {
    await using tmp = await tmpdir()
    const prompt = await mountPrompt(tmp.path, { root: { type: "busy" } })

    try {
      expect(prompt.frame).not.toContain("Subagent active")
    } finally {
      prompt.app.renderer.destroy()
    }
  })

  test("renders descendant-only activity exactly once", async () => {
    await using tmp = await tmpdir()
    const prompt = await mountPrompt(tmp.path, {
      child: { type: "busy" },
      grandchild: { type: "retry", attempt: 1, message: "", next: 0 },
    })

    try {
      expect(prompt.frame).toContain(label)
      expect(occurrences(prompt.frame, label)).toBe(1)
    } finally {
      prompt.app.renderer.destroy()
    }
  })
})

async function mountPrompt(root: string, statuses: Record<string, SessionStatus>) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ animations_enabled: false }))
  const errors: unknown[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json(sessions)
    if (url.pathname === "/session/status") return json(statuses)
  })
  let sync!: ReturnType<typeof useSync>

  function Content() {
    sync = useSync()
    return (
      <DataProvider>
        <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
          <LocalProvider>
            <PromptStashProvider>
              <DialogProvider>
                <FrecencyProvider>
                  <PromptHistoryProvider>
                    <EditorContextProvider integration={{}}>
                      <LocationProvider location={{ directory }}>
                        <Prompt sessionID="root" />
                      </LocationProvider>
                    </EditorContextProvider>
                  </PromptHistoryProvider>
                </FrecencyProvider>
              </DialogProvider>
            </PromptStashProvider>
          </LocalProvider>
        </ThemeProvider>
      </DataProvider>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts directory={directory} paths={{ home: root, state, worktree: root }}>
        <ClipboardProvider>
          <OpencodeKeymapProvider keymap={keymap}>
            <ArgsProvider continue>
              <KVProvider>
                <ToastProvider>
                  <RouteProvider initialRoute={{ type: "session", sessionID: "root" }}>
                    <TuiConfigProvider config={config}>
                      <SDKProvider url="http://test" directory={directory} events={eventSource()} fetch={calls.fetch}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <ExitProvider exit={(error) => errors.push(error)}>
                              <SyncProvider>
                                <Content />
                              </SyncProvider>
                            </ExitProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </TuiConfigProvider>
                  </RouteProvider>
                </ToastProvider>
              </KVProvider>
            </ArgsProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 140, height: 9, kittyKeyboard: true })
  for (let attempt = 0; attempt < 100; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (sync?.status === "complete" && frame.includes("esc interrupt")) return { app, frame }
    if (errors.length > 0) break
    await Bun.sleep(10)
  }

  app.renderer.destroy()
  throw new Error(`Prompt did not settle: ${errors.map(String).join(", ")}`)
}

function session(id: string, parentID: string | undefined, created: number): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory,
    parentID,
    title: id,
    version: "1",
    cost: 0,
    time: { created, updated: created },
  }
}

function occurrences(value: string, search: string) {
  return value.split(search).length - 1
}
