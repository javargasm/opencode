/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

const durableSession = {
  id: "ses_durable",
  title: "durable",
  time: { created: 0, updated: 0 },
  version: "2.0.0",
  directory: "/tmp/opencode/packages/tui",
}

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps durable pending inputs scoped to the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let pendingRequests = 0
    const { app, project, sync } = await mount((url) => {
      if (url.pathname === "/session") return json([durableSession])
      if (url.pathname === `/api/session/${durableSession.id}/input`) {
        pendingRequests++
        return json({
          data:
            pendingRequests === 1
              ? [
                  {
                    id: "msg_first",
                    sessionID: durableSession.id,
                    admittedSeq: 1,
                    delivery: "queue",
                    prompt: { text: "first" },
                    timeCreated: 1,
                  },
                ]
              : [
                  {
                    id: "msg_second",
                    sessionID: durableSession.id,
                    admittedSeq: 2,
                    delivery: "queue",
                    prompt: { text: "second" },
                    timeCreated: 2,
                  },
                ],
        })
      }
      return undefined
    }, tmp.path)

    try {
      await wait(() => sync.data.session_input[durableSession.id]?.[0]?.id === "msg_first")
      project.workspace.set("other")
      await sync.bootstrap({ fatal: false })
      await wait(() => sync.data.session_input[durableSession.id]?.[0]?.id === "msg_second")

      expect(sync.data.session_input[durableSession.id]).toHaveLength(1)
      expect(sync.data.session_input[durableSession.id][0]?.id).toBe("msg_second")
    } finally {
      app.renderer.destroy()
    }
  })
})
