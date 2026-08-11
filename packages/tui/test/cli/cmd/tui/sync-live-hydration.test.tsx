/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_hydration_race"
const messageID = "msg_hydration_race"
const partID = "prt_hydration_race"
const sessionStatusTiming = { refreshInterval: 50, requestTimeout: 40 }
const session = {
  id: sessionID,
  title: "race",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/opencode",
}
const assistant = {
  id: messageID,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
}

function global(payload: GlobalEvent["payload"], workspace?: string): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", workspace, payload }
}

function untilAborted(signal: AbortSignal | null | undefined) {
  return new Promise<Response>((_, reject) => {
    const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    if (signal?.aborted) return abort()
    signal?.addEventListener("abort", abort, { once: true })
  })
}

test("live messages use creation time with an ID tie-break", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const messages = [
    { ...assistant, id: "msg_a", time: { created: 30, completed: 31 } },
    { ...assistant, id: "msg_z", time: { created: 10, completed: 11 } },
    { ...assistant, id: "msg_m", time: { created: 20, completed: 21 } },
    { ...assistant, id: "msg_b", time: { created: 20, completed: 21 } },
  ]

  try {
    for (const info of messages) {
      emit(global({ id: `evt_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    }
    await wait(() => sync.data.message[sessionID]?.length === messages.length)

    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_m", "msg_a"])
  } finally {
    app.renderer.destroy()
  }
})

test("stale session hydration does not overwrite live message parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: { id: partID, sessionID, messageID, type: "text", text: "visible live content" },
        },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    resolveMessages(
      json([
        {
          info: assistant,
          parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }],
        },
      ]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible live content" })
  } finally {
    app.renderer.destroy()
  }
})

test("live tool output deltas update running metadata", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(() => undefined, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: {
            id: partID,
            sessionID,
            messageID,
            type: "tool",
            callID: "call",
            tool: "bash",
            state: {
              status: "running",
              input: { command: "echo streamed" },
              time: { start: 1 },
            },
          },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "metadata.output", delta: " streamed" },
      }),
    )

    await wait(() => {
      const part = sync.data.part[messageID]?.[0]
      return part?.type === "tool" && part.state.status === "running" && part.state.metadata?.output === " streamed"
    })

    expect(sync.data.part[messageID][0]).toMatchObject({ state: { metadata: { output: " streamed" } } })
  } finally {
    app.renderer.destroy()
  }
})

test("orphan live deltas do not suppress hydrated parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "ignored until part exists" },
      }),
    )
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "hydrated" }] }]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "hydrated" })
  } finally {
    app.renderer.destroy()
  }
})

test("hydration does not clear text streamed before it starts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: partID, sessionID, messageID, type: "text", text: "" },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "visible streamed content" },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text !== "")
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    resolveMessages(json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }] }]))
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible streamed content" })
  } finally {
    app.renderer.destroy()
  }
})

test("live messages merged during hydration retain the 100 message window", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    const live = { ...assistant, id: "msg_z_live" }
    emit(global({ id: "evt_live", type: "message.updated", properties: { sessionID, info: live } }))
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === live.id) ?? false)
    resolveMessages(
      json(
        Array.from({ length: 100 }, (_, index) => {
          const id = `msg_${String(index).padStart(3, "0")}`
          return {
            info: { ...assistant, id },
            parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: id }],
          }
        }),
      ),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toHaveLength(100)
    expect(sync.data.message[sessionID].at(-1)?.id).toBe(live.id)
    expect(sync.data.message[sessionID].some((message) => message.id === "msg_000")).toBe(false)
    expect(sync.data.part.msg_000).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a message removed during hydration does not regain stale parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    await wait(() => sync.data.message[sessionID]?.length === 1)
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_removed", type: "message.removed", properties: { sessionID, messageID } }))
    await wait(() => sync.data.message[sessionID]?.length === 0)
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("server reconnect replaces stale session statuses with the authoritative snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname !== "/session/status") return undefined
    requests++
    return json(requests === 1 ? { child: { type: "busy" } } : {})
  }, tmp.path)

  try {
    expect(sync.data.session_status.child).toEqual({ type: "busy" })
    emit(global({ id: "evt_connected", type: "server.connected", properties: {} }))
    await wait(() => sync.data.session_status.child === undefined)

    expect(requests).toBe(2)
  } finally {
    app.renderer.destroy()
  }
})

test("global reconnect refreshes the current named workspace", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requests = 0
  const { app, emit, project, sync } = await mount((url) => {
    if (url.pathname === "/experimental/workspace") return json([{ id: "second" }])
    if (url.pathname !== "/session/status" || url.searchParams.get("workspace") !== "second") return undefined
    requests++
    return json(requests === 1 ? { child: { type: "busy" } } : {})
  }, tmp.path)

  try {
    project.workspace.set("second")
    await sync.bootstrap({ fatal: false })
    await wait(() => sync.data.session_status.child?.type === "busy")

    emit(global({ id: "evt_named_connected", type: "server.connected", properties: {} }))
    await wait(() => requests === 2)
    await wait(() => sync.data.session_status.child === undefined)
  } finally {
    app.renderer.destroy()
  }
})

test("active session statuses reconcile periodically without a reconnect", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requests = 0
  const { app, sync } = await mount(
    (url) => {
      if (url.pathname !== "/session/status") return undefined
      requests++
      return json(requests === 1 ? { child: { type: "busy" } } : {})
    },
    tmp.path,
    sessionStatusTiming,
  )

  try {
    expect(sync.data.session_status.child).toEqual({ type: "busy" })
    await wait(() => sync.data.session_status.child === undefined)

    expect(requests).toBeGreaterThanOrEqual(2)
  } finally {
    app.renderer.destroy()
  }
})

test("reconnect status refresh cannot overwrite a newer live status event", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let resolveStale!: (response: Response) => void
  const stale = new Promise<Response>((resolve) => {
    resolveStale = resolve
  })
  let requests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname !== "/session/status") return undefined
    requests++
    if (requests === 1) return json({})
    if (requests === 2) return stale
    return json({ child: { type: "busy" } })
  }, tmp.path)

  try {
    emit(global({ id: "evt_connected", type: "server.connected", properties: {} }))
    await wait(() => requests === 2)
    emit(
      global({
        id: "evt_status",
        type: "session.status",
        properties: { sessionID: "child", status: { type: "busy" } },
      }),
    )
    await wait(() => sync.data.session_status.child?.type === "busy")
    resolveStale(json({}))
    await wait(() => requests === 3)
    await wait(() => sync.data.session_status.child?.type === "busy")

    expect(sync.data.session_status.child).toEqual({ type: "busy" })
  } finally {
    app.renderer.destroy()
  }
})

test("workspace switch supersedes an in-flight status snapshot", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let resolveFirst!: (response: Response) => void
  const first = new Promise<Response>((resolve) => {
    resolveFirst = resolve
  })
  let firstRequests = 0
  let secondRequests = 0
  const { app, project, sync } = await mount((url) => {
    if (url.pathname === "/experimental/workspace") return json([{ id: "first" }, { id: "second" }])
    if (url.pathname !== "/session/status") return undefined
    const workspace = url.searchParams.get("workspace")
    if (workspace === "first") {
      firstRequests++
      return first
    }
    if (workspace === "second") {
      secondRequests++
      return json({ second: { type: "busy" } })
    }
    return json({})
  }, tmp.path)

  try {
    project.workspace.set("first")
    void sync.bootstrap({ fatal: false })
    await wait(() => firstRequests === 1)
    project.workspace.set("second")
    void sync.bootstrap({ fatal: false })
    await wait(() => secondRequests === 1)
    await wait(() => sync.data.session_status.second?.type === "busy")

    resolveFirst(json({ first: { type: "busy" } }))
    await Bun.sleep(20)
    expect(sync.data.session_status.first).toBeUndefined()
    expect(sync.data.session_status.second).toEqual({ type: "busy" })
  } finally {
    app.renderer.destroy()
  }
})

test("delayed bootstrap cannot reclaim status ownership after a workspace switch", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let releaseFirst!: (response: Response) => void
  const firstProviders = new Promise<Response>((resolve) => {
    releaseFirst = resolve
  })
  let firstBlocked = false
  let firstRequests = 0
  let secondRequests = 0
  const { app, project, sync } = await mount((url) => {
    if (url.pathname === "/experimental/workspace") return json([{ id: "first" }, { id: "second" }])
    const workspace = url.searchParams.get("workspace")
    if (url.pathname === "/config/providers" && workspace === "first") {
      firstBlocked = true
      return firstProviders
    }
    if (url.pathname !== "/session/status") return undefined
    if (workspace === "first") {
      firstRequests++
      return json({ first: { type: "busy" } })
    }
    if (workspace === "second") {
      secondRequests++
      return json({ second: { type: "busy" } })
    }
    return json({})
  }, tmp.path)

  try {
    project.workspace.set("first")
    const stale = sync.bootstrap({ fatal: false })
    await wait(() => firstBlocked)
    project.workspace.set("second")
    await sync.bootstrap({ fatal: false })
    await wait(() => sync.data.session_status.second?.type === "busy")

    releaseFirst(json({ providers: {}, default: {} }))
    await stale
    await Bun.sleep(20)

    expect(firstRequests).toBe(0)
    expect(secondRequests).toBe(1)
    expect(sync.data.session_status.first).toBeUndefined()
    expect(sync.data.session_status.second).toEqual({ type: "busy" })
  } finally {
    app.renderer.destroy()
  }
})

test("selected workspace status refresh survives a stalled bootstrap", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let releaseProviders!: (response: Response) => void
  const providers = new Promise<Response>((resolve) => {
    releaseProviders = resolve
  })
  let blocked = false
  let requests = 0
  const { app, project, sync } = await mount(
    (url) => {
      const workspace = url.searchParams.get("workspace")
      if (url.pathname === "/experimental/workspace") return json([{ id: "second" }])
      if (url.pathname === "/config/providers" && workspace === "second") {
        blocked = true
        return providers
      }
      if (url.pathname === "/session/status" && workspace === "second") {
        requests++
        return json({ child: { type: "busy" } })
      }
      return undefined
    },
    tmp.path,
    sessionStatusTiming,
  )

  try {
    project.workspace.set("second")
    const bootstrap = sync.bootstrap({ fatal: false })
    await wait(() => blocked)
    await wait(() => requests === 1)
    await wait(() => sync.data.session_status.child?.type === "busy")

    releaseProviders(json({ providers: {}, default: {} }))
    await bootstrap
  } finally {
    releaseProviders(json({ providers: {}, default: {} }))
    app.renderer.destroy()
  }
})

test("inactive workspace status events cannot mutate the active cache", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, project, sync } = await mount((url) => {
    if (url.pathname === "/experimental/workspace") return json([{ id: "first" }, { id: "second" }])
    if (url.pathname !== "/session/status") return undefined
    if (url.searchParams.get("workspace") === "second") return json({ second: { type: "busy" } })
    return json({})
  }, tmp.path)

  try {
    project.workspace.set("second")
    await sync.bootstrap({ fatal: false })
    await wait(() => sync.data.session_status.second?.type === "busy")

    emit(
      global(
        {
          id: "evt_inactive_status",
          type: "session.status",
          properties: { sessionID: "first", status: { type: "busy" } },
        },
        "first",
      ),
    )
    await Bun.sleep(20)
    expect(sync.data.session_status.first).toBeUndefined()
    expect(sync.data.session_status.second).toEqual({ type: "busy" })

    emit(
      global(
        {
          id: "evt_active_status",
          type: "session.status",
          properties: { sessionID: "second", status: { type: "idle" } },
        },
        "second",
      ),
    )
    await wait(() => sync.data.session_status.second?.type === "idle")
  } finally {
    app.renderer.destroy()
  }
})

test("failed status refresh preserves cache and permits a later retry", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let requests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname !== "/session/status") return undefined
    requests++
    if (requests === 1) return json({ child: { type: "busy" } })
    if (requests === 2) return json({ message: "unavailable" }, { status: 503 })
    return json({})
  }, tmp.path)

  try {
    emit(global({ id: "evt_failed_connected", type: "server.connected", properties: {} }))
    await wait(() => requests === 2)
    await Bun.sleep(20)
    expect(sync.data.session_status.child).toEqual({ type: "busy" })

    emit(global({ id: "evt_retry_connected", type: "server.connected", properties: {} }))
    await wait(() => requests === 3)
    await wait(() => sync.data.session_status.child === undefined)
  } finally {
    app.renderer.destroy()
  }
})

test("new reconnect supersedes a hung status refresh", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let resolveHung!: (response: Response) => void
  const hung = new Promise<Response>((resolve) => {
    resolveHung = resolve
  })
  let requests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname !== "/session/status") return undefined
    requests++
    if (requests === 1) return json({ child: { type: "busy" } })
    if (requests === 2) return hung
    return json({})
  }, tmp.path)

  try {
    emit(global({ id: "evt_hung_connected", type: "server.connected", properties: {} }))
    await wait(() => requests === 2)
    emit(global({ id: "evt_reconnected", type: "server.connected", properties: {} }))
    await wait(() => requests === 3)
    await wait(() => sync.data.session_status.child === undefined)

    resolveHung(json({ child: { type: "busy" } }))
    await Bun.sleep(20)
    expect(sync.data.session_status.child).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("hung status refresh is aborted and retried automatically", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let hungSignal: AbortSignal | null | undefined
  let requests = 0
  const { app, emit, sync } = await mount(
    (url, signal) => {
      if (url.pathname !== "/session/status") return undefined
      requests++
      if (requests === 1) return json({})
      if (requests === 2) {
        hungSignal = signal
        return untilAborted(signal)
      }
      return json({})
    },
    tmp.path,
    sessionStatusTiming,
  )

  try {
    emit(global({ id: "evt_timeout_connected", type: "server.connected", properties: {} }))
    await wait(() => requests === 2)
    await wait(() => requests >= 3)
    await wait(() => sync.data.session_status.child === undefined)

    expect(hungSignal?.aborted).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

test("destroy aborts an in-flight status refresh", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let hungSignal: AbortSignal | null | undefined
  let requests = 0
  const { app, emit } = await mount((url, signal) => {
    if (url.pathname !== "/session/status") return undefined
    requests++
    if (requests === 1) return json({})
    hungSignal = signal
    return untilAborted(signal)
  }, tmp.path)

  emit(global({ id: "evt_destroy_connected", type: "server.connected", properties: {} }))
  await wait(() => requests === 2)
  app.renderer.destroy()

  expect(hungSignal?.aborted).toBe(true)
})
