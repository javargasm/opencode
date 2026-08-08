import { describe, expect, test } from "bun:test"
import {
  applyBackgroundTaskPart,
  projectBackgroundTasks,
  reconcileBackgroundTasks,
} from "@/cli/cmd/run/background-tasks"

function start(id: string, partID = "prt_001", generation?: string) {
  return {
    id: partID,
    messageID: "msg_parent",
    sessionID: "ses_parent",
    type: "tool",
    tool: "task",
    state: {
      status: "completed",
      input: {},
      output: "started",
      title: "task",
      metadata: { background: true, sessionId: id, ...(generation ? { backgroundTaskGeneration: generation } : {}) },
      time: { start: 1, end: 2 },
    },
  }
}

function terminal(id: string, state: "completed" | "error" | "cancelled", partID = "prt_002", generation?: string) {
  return {
    id: partID,
    messageID: "msg_terminal",
    sessionID: "ses_parent",
    type: "text",
    synthetic: true,
    text: "terminal",
    metadata: {
      backgroundTaskID: id,
      backgroundTaskState: state,
      ...(generation ? { backgroundTaskGeneration: generation } : {}),
    },
  }
}

describe("run background task projection", () => {
  test("seeds an attached run from a durable pending background launch", () => {
    const tasks = projectBackgroundTasks([{ info: {}, parts: [start("ses_child")] }])

    expect([...tasks.keys()]).toEqual(["ses_child"])
  })

  test.each(["completed", "error", "cancelled"] as const)(
    "does not retain a task with a durable %s terminal",
    (state) => {
      const tasks = projectBackgroundTasks([{ info: {}, parts: [start("ses_child"), terminal("ses_child", state)] }])

      expect(tasks.size).toBe(0)
    },
  )

  test("applies queued cancellation after the attached history snapshot", () => {
    const tasks = projectBackgroundTasks([{ info: {}, parts: [start("ses_child")] }])

    expect(applyBackgroundTaskPart(tasks, terminal("ses_child", "cancelled"))).toBe("cancelled")
    expect(tasks.size).toBe(0)
  })

  test("a later durable relaunch of the same task ID becomes active again", () => {
    const tasks = projectBackgroundTasks([
      {
        info: {},
        parts: [
          start("ses_child", "prt_001"),
          terminal("ses_child", "error", "prt_002"),
          start("ses_child", "prt_003"),
        ],
      },
    ])

    expect([...tasks.keys()]).toEqual(["ses_child"])
  })

  test("a late terminal cannot remove a newer generation with the same task ID", () => {
    const tasks = projectBackgroundTasks([
      {
        info: {},
        parts: [
          start("ses_child", "prt_001", "generation-1"),
          start("ses_child", "prt_002", "generation-2"),
          terminal("ses_child", "cancelled", "prt_003", "generation-1"),
        ],
      },
    ])

    expect([...tasks]).toEqual([["ses_child", "generation-2"]])
    expect(applyBackgroundTaskPart(tasks, terminal("ses_child", "completed", "prt_004", "generation-2"))).toBe(
      "completed",
    )
    expect(tasks.size).toBe(0)
  })

  test("a legacy terminal does not remove a modern generation", () => {
    const tasks = projectBackgroundTasks([{ info: {}, parts: [start("ses_child", "prt_001", "generation-1")] }])

    expect(applyBackgroundTaskPart(tasks, terminal("ses_child", "cancelled"))).toBeUndefined()
    expect([...tasks]).toEqual([["ses_child", "generation-1"]])
  })

  test("legacy launches and terminals remain compatible", () => {
    const tasks = projectBackgroundTasks([{ info: {}, parts: [start("ses_child")] }])

    expect(applyBackgroundTaskPart(tasks, terminal("ses_child", "cancelled"))).toBe("cancelled")
    expect(tasks.size).toBe(0)
  })

  test("does not resurrect a task from a waiting replay part", () => {
    const tasks = projectBackgroundTasks([
      {
        info: {},
        parts: [
          start("ses_child", "prt_001", "generation-1"),
          terminal("ses_child", "completed", "prt_002", "generation-1"),
        ],
      },
    ])

    expect(
      applyBackgroundTaskPart(tasks, {
        id: "prt_003",
        messageID: "msg_parent",
        sessionID: "ses_parent",
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: {},
          output: "waiting",
          title: "task",
          metadata: {
            background: true,
            sessionId: "ses_child",
            backgroundTaskGeneration: "generation-1",
            backgroundTaskState: "waiting",
          },
          time: { start: 3, end: 4 },
        },
      }),
    ).toBeUndefined()
    expect(tasks.size).toBe(0)
  })

  test("restart reconciliation keeps only tasks returned by durable storage", () => {
    const tasks = projectBackgroundTasks([
      {
        info: {},
        parts: [start("ses_running", "prt_001", "generation-1"), start("ses_orphan", "prt_002")],
      },
    ])

    expect(reconcileBackgroundTasks(tasks, ["ses_running", "ses_durable_only"])).toBe(tasks)
    expect([...tasks]).toEqual([["ses_running", "generation-1"]])
  })

  test("restart reconciliation clears launches absent from durable storage", () => {
    const tasks = projectBackgroundTasks([{ info: {}, parts: [start("ses_orphan")] }])

    reconcileBackgroundTasks(tasks, [])

    expect(tasks.size).toBe(0)
  })
})
