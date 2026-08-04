import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"

import { TaskStopTool, TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer(flags)]],
  )

const it = testEffect(layer())
const background = testEffect(layer({ experimentalBackgroundSubagents: true }))

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
    wake: (_sessionID, admission) => admission,
  }
}

function taskContext(sessionID: SessionID, messageID: MessageID, promptOps: TaskPromptOps) {
  return {
    sessionID,
    messageID,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): SessionV1.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.instance("does not register task_stop without background subagents", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* registry.ids()).not.toContain(TaskStopTool.id)
    }),
  )

  background.instance("registers task_stop only for non-subagent agents with a non-empty schema", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const registry = yield* ToolRegistry.Service
      const build = yield* agents.get("build")
      const general = yield* agents.get("general")
      const primary = (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskStopTool.id)

      expect(primary).toBeDefined()
      expect((yield* registry.tools({ ...ref, agent: general })).some((tool) => tool.id === TaskStopTool.id)).toBe(
        false,
      )
      expect(Schema.decodeUnknownOption(primary!.parameters)({ task_ids: [] })._tag).toBe("None")
      expect(Schema.decodeUnknownOption(primary!.parameters)({ task_ids: ["ses_child"] })._tag).toBe("Some")
    }),
  )

  background.instance(
    "task_stop allows a root session using an all-mode agent and rejects a child session",
    () =>
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const jobs = yield* BackgroundJob.Service
        const registry = yield* ToolRegistry.Service
        const runState = yield* SessionRunState.Service
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const omni = yield* agents.get("omni")
        const child = yield* sessions.create({ parentID: chat.id, title: "Owned child" })
        yield* jobs.start({
          id: child.id,
          type: TaskTool.id,
          title: child.title,
          metadata: { parentSessionId: chat.id, sessionId: child.id, background: true },
          run: Effect.never,
        })

        expect((yield* registry.tools({ ...ref, agent: omni })).some((tool) => tool.id === TaskStopTool.id)).toBe(
          true,
        )

        const stop = yield* TaskStopTool
        const def = yield* stop.init()
        const promptOps = {
          ...stubOps(),
          cancel: (sessionID: SessionID) => runState.cancel(sessionID),
        }
        const root = yield* def.execute(
          { task_ids: [child.id] },
          { ...taskContext(chat.id, assistant.id, promptOps), agent: "omni" },
        )
        expect(root.metadata.statuses).toEqual([{ task_id: child.id, status: "cancelled" }])

        const grandchild = yield* sessions.create({ parentID: child.id, title: "Nested child" })
        yield* jobs.start({
          id: grandchild.id,
          type: TaskTool.id,
          title: grandchild.title,
          metadata: { parentSessionId: child.id, sessionId: grandchild.id, background: true },
          run: Effect.never,
        })
        const nested = yield* def
          .execute(
            { task_ids: [grandchild.id] },
            { ...taskContext(child.id, assistant.id, promptOps), agent: "omni" },
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(nested)).toBe(true)
        expect((yield* jobs.get(grandchild.id))?.status).toBe("running")
      }),
    {
      config: {
        agent: {
          omni: {
            description: "Omni agent",
            mode: "all",
          },
        },
      },
    },
  )

  it.instance(
    "description sorts subagents by name and is stable across calls",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const get = Effect.fnUntraced(function* () {
          const tools = yield* registry.tools({ ...ref, agent: build })
          return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
        })
        const first = yield* get()
        const second = yield* get()

        expect(first).toBe(second)

        const alpha = first.indexOf("- alpha: Alpha agent")
        const explore = first.indexOf("- explore:")
        const general = first.indexOf("- general:")
        const zebra = first.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      }),
    {
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance(
    "description hides denied subagents for the caller",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const build = yield* agent.get("build")
        const registry = yield* ToolRegistry.Service
        const description =
          (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

        expect(description).toContain("- alpha: Alpha agent")
        expect(description).not.toContain("- zebra: Zebra agent")
      }),
    {
      config: {
        permission: {
          task: {
            "*": "allow",
            zebra: "deny",
          },
        },
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    },
  )

  it.instance("execute resumes an existing task session from task_id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "resumed", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: child.id,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task id="${child.id}" state="completed">`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.variant).toBe("xhigh")
    }),
  )

  it.instance("execute rejects an existing task_id owned by another session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const foreign = yield* sessions.create({ title: "Other parent" })
      const child = yield* sessions.create({ parentID: foreign.id, title: "Foreign child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            task_id: child.id,
          },
          taskContext(chat.id, assistant.id, stubOps()),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("execute asks by default and skips checks when bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      const promptOps = stubOps()

      const exec = (extra?: Record<string, any>) =>
        def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, ...extra },
            messages: [],
            metadata: () => Effect.void,
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

      yield* exec()
      yield* exec({ bypassAgentCheck: true })

      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual({
        permission: "task",
        patterns: ["general"],
        always: ["*"],
        metadata: {
          description: "inspect bug",
          subagent_type: "general",
        },
      })
    }),
  )

  it.instance("execute cancels child session when abort signal fires", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()
      const cancelled = defer<SessionID>()
      const abort = new AbortController()
      const promptOps: TaskPromptOps = {
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled.resolve(sessionID)
          }),
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
        wake: (_sessionID, admission) => admission,
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: abort.signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      const input = yield* Effect.promise(() => ready.promise)
      abort.abort()
      expect(yield* Effect.promise(() => cancelled.promise)).toBe(input.sessionID)

      const exit = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(exit)).toBe(true)
    }),
  )

  it.instance("execute creates a child when task_id does not exist", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const promptOps = stubOps({ text: "created", onPrompt: (input) => (seen = input) })

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          task_id: "ses_missing",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(result.metadata.sessionId)
      expect(result.metadata.sessionId).not.toBe("ses_missing")
      expect(result.output).toContain(`<task id="${result.metadata.sessionId}" state="completed">`)
      expect(seen?.sessionID).toBe(result.metadata.sessionId)
    }),
  )

  it.instance("prevents subagents from launching subagents by default", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const nestedAssistant = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: child.id,
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(child.id)).toHaveLength(0)
    }),
  )

  it.instance(
    "allows nested subagents up to the configured depth",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "child" })
        const nestedAssistant = yield* sessions.updateMessage({
          ...assistant,
          id: MessageID.ascending(),
          parentID: MessageID.ascending(),
          sessionID: child.id,
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: child.id,
            messageID: nestedAssistant.id,
            agent: "general",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(child.id)
      }),
    { config: { subagent_depth: 2 } },
  )

  it.instance(
    "execute shapes child permissions for task, todowrite, and primary tools",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "reviewer",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        const child = yield* sessions.get(result.metadata.sessionId)
        expect(child.parentID).toBe(chat.id)
        expect(child.agent).toBe("reviewer")
        expect(child.permission).toEqual([
          {
            permission: "todowrite",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "bash",
            pattern: "*",
            action: "deny",
          },
          {
            permission: "read",
            pattern: "*",
            action: "deny",
          },
        ])
        expect(seen?.tools).toBeUndefined()
      }),
    {
      config: {
        agent: {
          reviewer: {
            mode: "subagent",
            permission: {
              task: "allow",
            },
          },
        },
        experimental: {
          primary_tools: ["bash", "read"],
        },
      },
    },
  )

  it.instance("rejects background execution when the experiment is disabled", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: true,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps: stubOps() },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("promotes a running foreground task without restarting it", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const injected = yield* Deferred.make<SessionPrompt.PromptInput>()
      let runs = 0
      const promptOps: TaskPromptOps = {
        cancel: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(injected, input).pipe(Effect.as(reply(input, "injected")))
          }
          return Effect.gen(function* () {
            runs += 1
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(done)
            return reply(input, "background done")
          })
        },
        wake: (_sessionID, admission) => admission,
      }

      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      const job = (yield* jobs.list())[0]
      expect(job).toBeDefined()
      if (!job) throw new Error("task job not found")
      expect(job.metadata?.parentSessionId).toBe(chat.id)
      yield* jobs.promote(job.id)

      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect((yield* jobs.get(result.metadata.sessionId))?.status).toBe("running")
      expect(runs).toBe(1)

      yield* Deferred.succeed(done, undefined)
      expect((yield* jobs.wait({ id: result.metadata.sessionId })).info?.output).toBe("background done")
      expect((yield* Deferred.await(injected)).parts[0]?.type).toBe("text")
      expect(runs).toBe(1)
    }),
  )

  background.instance("execute launches background tasks without waiting for completion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: () => Effect.never,
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.timeout("1 second"))

      expect(def.description).toContain("Omitting background launches the subagent asynchronously")
      const job = yield* jobs.get(result.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain(`state="running"`)
      expect(job?.status).toBe("running")
    }),
  )

  background.instance("explicit background false stays foreground", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const fiber = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: false,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: {
              promptOps: {
                ...stubOps(),
                prompt: (input) =>
                  Deferred.succeed(ready, undefined).pipe(
                    Effect.andThen(Deferred.await(done)),
                    Effect.as(reply(input, "done")),
                  ),
              } satisfies TaskPromptOps,
            },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.forkChild)

      yield* Deferred.await(ready)
      expect((yield* Fiber.await(fiber).pipe(Effect.timeoutOption("10 millis")))._tag).toBe("None")
      yield* Deferred.succeed(done, undefined)
      const result = yield* Fiber.join(fiber)
      expect(result.metadata.background).toBeUndefined()
      expect(result.output).toContain(`state="completed"`)
    }),
  )

  background.instance("completed background tasks notify with the remaining parallel tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const other = yield* sessions.create({ title: "Other parent" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      expect(def.description).toContain(
        "Use background execution for independent parallel subagents when you must react to each completion or error",
      )
      const completed = defer<void>()
      const notification = defer<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            notification.resolve(input)
            return Effect.succeed(reply(input, "notified"))
          }
          if (input.parts[0]?.type === "text" && input.parts[0].text === "run A") {
            return Effect.promise(() => completed.promise).pipe(Effect.as(reply(input, "A done")))
          }
          return Effect.never
        },
      }
      const context = taskContext(chat.id, assistant.id, promptOps)
      const launch = (description: string, prompt: string) =>
        def.execute({ description, prompt, subagent_type: "general", background: true }, context)

      const a = yield* launch("subagent A", "run A")
      const b = yield* launch("subagent B", "hold B")
      const d = yield* launch("subagent D", "hold D")
      yield* jobs.start({
        id: "other-parent-task",
        type: "task",
        title: "other task",
        metadata: { parentSessionId: other.id },
        run: Effect.never,
      })

      completed.resolve()
      const injected = yield* Effect.promise(() => notification.promise)
      expect(injected.parts[0]?.type).toBe("text")
      if (injected.parts[0]?.type !== "text") throw new Error("background notification text not found")
      expect(injected.parts[0].text).toContain(`<task id="${a.metadata.sessionId}" state="completed">`)
      expect(injected.parts[0].text).toContain(
        `<active_tasks>${JSON.stringify([
          { task_id: b.metadata.sessionId, description: "subagent B" },
          { task_id: d.metadata.sessionId, description: "subagent D" },
        ])}</active_tasks>`,
      )
      expect(injected.parts[0].text).not.toContain("other-parent-task")
      expect(injected.parts[0].text).toContain("React to this event now")
      expect(injected.parts[0].text).toContain("Do not poll the active tasks")
      expect((yield* jobs.get(b.metadata.sessionId))?.status).toBe("running")
      expect((yield* jobs.get(d.metadata.sessionId))?.status).toBe("running")
    }),
  )

  background.instance("persists one visible acknowledgement before waking for each parallel completion", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const firstWoke = defer<void>()
      const woke = defer<void>()
      const admitted: SessionPrompt.PromptInput[] = []
      const wakeCalls: SessionID[] = []
      const promptOps = {
        ...stubOps(),
        prompt: (input: SessionPrompt.PromptInput) => {
          if (input.sessionID !== chat.id) {
            const gate = input.parts[0]?.type === "text" && input.parts[0].text === "run A" ? first : second
            const text = gate === first ? "A done" : "B done"
            return Effect.promise(() => gate.promise).pipe(Effect.as(reply(input, text)))
          }
          return Effect.gen(function* () {
            admitted.push(input)
            const info = yield* sessions.updateMessage({
              id: input.messageID ?? MessageID.ascending(),
              sessionID: input.sessionID,
              role: "user",
              time: { created: Date.now() },
              agent: input.agent ?? "build",
              model: { ...ref, variant: input.variant },
            })
            const source = input.parts[0]
            if (source?.type !== "text") throw new Error("background notification text not found")
            const part = yield* sessions.updatePart({
              ...source,
              id: source.id ?? PartID.ascending(),
              messageID: info.id,
              sessionID: info.sessionID,
            })
            return { info, parts: [part] }
          })
        },
        wake: (sessionID: SessionID, admission: Effect.Effect<void>) =>
          admission.pipe(
            Effect.andThen(
              Effect.sync(() => {
                wakeCalls.push(sessionID)
                if (wakeCalls.length === 1) firstWoke.resolve()
                if (wakeCalls.length === 2) woke.resolve()
              }),
            ),
          ),
      } satisfies TaskPromptOps
      const context = taskContext(chat.id, assistant.id, promptOps)

      yield* def.execute(
        { description: "subagent A", prompt: "run A", subagent_type: "general", background: true },
        context,
      )
      yield* def.execute(
        { description: "subagent B", prompt: "run B", subagent_type: "general", background: true },
        context,
      )
      first.resolve()
      yield* Effect.promise(() => firstWoke.promise).pipe(Effect.timeout("1 second"))
      second.resolve()
      yield* Effect.promise(() => woke.promise).pipe(Effect.timeout("1 second"))

      expect(admitted).toHaveLength(2)
      expect(admitted.every((input) => input.noReply === true)).toBe(true)
      expect(wakeCalls).toEqual([chat.id, chat.id])

      const messages = yield* sessions.messages({ sessionID: chat.id }).pipe(Effect.orDie)
      const notifications = messages.filter(
        (message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("<task id=")),
      )
      const acknowledgements = messages.filter((message) => {
        const info = message.info
        if (info.role !== "assistant") return false
        return notifications.some((notification) => notification.info.id === info.parentID)
      })
      expect(notifications).toHaveLength(2)
      expect(acknowledgements).toHaveLength(2)
      expect(
        acknowledgements.map((message) => message.parts.find((part) => part.type === "text")),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: "Background task completed: subagent A. Still running: subagent B.",
            synthetic: true,
            ignored: true,
          }),
          expect.objectContaining({
            text: "Background task completed: subagent B. No background tasks remain.",
            synthetic: true,
            ignored: true,
          }),
        ]),
      )
    }),
  )

  background.instance("serializes parallel terminal admission through each parent wake", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const firstWoke = defer<void>()
      const releaseFirstWake = defer<void>()
      const secondAdmitted = defer<void>()
      const secondWoke = defer<void>()
      let admissions = 0
      let wakes = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            admissions++
            if (admissions === 2) secondAdmitted.resolve()
            return Effect.succeed(reply(input, "notified"))
          }
          const gate = input.parts[0]?.type === "text" && input.parts[0].text === "run A" ? first : second
          return Effect.promise(() => gate.promise).pipe(Effect.as(reply(input, "done")))
        },
        wake: (_sessionID, admission) =>
          Effect.gen(function* () {
            yield* admission
            wakes++
            if (wakes === 1) {
              firstWoke.resolve()
              yield* Effect.promise(() => releaseFirstWake.promise)
              return
            }
            secondWoke.resolve()
          }),
      }
      const context = taskContext(chat.id, assistant.id, promptOps)

      yield* def.execute(
        { description: "subagent A", prompt: "run A", subagent_type: "general", background: true },
        context,
      )
      yield* def.execute(
        { description: "subagent B", prompt: "run B", subagent_type: "general", background: true },
        context,
      )
      first.resolve()
      second.resolve()
      yield* Effect.promise(() => firstWoke.promise).pipe(Effect.timeout("1 second"))

      expect(
        (yield* Effect.promise(() => secondAdmitted.promise).pipe(Effect.timeoutOption("10 millis")))._tag,
      ).toBe("None")
      expect(admissions).toBe(1)

      releaseFirstWake.resolve()
      yield* Effect.promise(() => secondWoke.promise).pipe(Effect.timeout("1 second"))
      expect(admissions).toBe(2)
      expect(wakes).toBe(2)
    }),
  )

  background.instance("admits terminal events after sibling notifications register", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const fail = defer<void>()
      const firstWoke = defer<void>()
      const releaseWake = defer<void>()
      const notification = defer<SessionPrompt.PromptInput>()
      const promptOps = {
        ...stubOps(),
        prompt: (input: SessionPrompt.PromptInput) => {
          if (input.sessionID === chat.id) {
            notification.resolve(input)
            return Effect.succeed(reply(input, "notified"))
          }
          if (input.parts[0]?.type === "text" && input.parts[0].text === "fail A") {
            return Effect.promise(() => fail.promise).pipe(
              Effect.flatMap(() => Effect.die(new Error("A exploded"))),
            )
          }
          return Effect.never
        },
        wake: (_sessionID: SessionID, admission: Effect.Effect<void>) =>
          Effect.gen(function* () {
            firstWoke.resolve()
            yield* Effect.promise(() => releaseWake.promise)
            yield* admission
          }),
      } satisfies TaskPromptOps
      const context = taskContext(chat.id, assistant.id, promptOps)
      const launch = (description: string, prompt: string) =>
        def.execute({ description, prompt, subagent_type: "general", background: true }, context)

      const a = yield* launch("subagent A", "fail A")
      fail.resolve()
      yield* Effect.promise(() => firstWoke.promise).pipe(Effect.timeout("1 second"))
      const b = yield* launch("subagent B", "hold B")
      const d = yield* launch("subagent D", "hold D")

      releaseWake.resolve()
      const admitted = yield* Effect.promise(() => notification.promise).pipe(Effect.timeout("1 second"))
      expect(admitted.parts[0]?.type).toBe("text")
      if (admitted.parts[0]?.type !== "text") throw new Error("background failure notification text not found")
      expect(admitted.parts[0].text).toContain(`<task id="${a.metadata.sessionId}" state="error">`)
      expect(admitted.parts[0].text).toContain(
        `<active_tasks>${JSON.stringify([
          { task_id: b.metadata.sessionId, description: "subagent B" },
          { task_id: d.metadata.sessionId, description: "subagent D" },
        ])}</active_tasks>`,
      )
    }),
  )

  background.instance("failed background tasks can restart while parallel tasks keep running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const fail = defer<void>()
      const retry = defer<void>()
      const finishB = defer<void>()
      const firstNotification = defer<SessionPrompt.PromptInput>()
      const secondNotification = defer<SessionPrompt.PromptInput>()
      const firstWoke = defer<void>()
      const releaseFirstWake = defer<void>()
      const secondWoke = defer<void>()
      let notifications = 0
      let wakes = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            notifications++
            ;(notifications === 1 ? firstNotification : secondNotification).resolve(input)
            return Effect.succeed(reply(input, "notified"))
          }
          if (input.parts[0]?.type === "text" && input.parts[0].text === "fail A") {
            return Effect.promise(() => fail.promise).pipe(
              Effect.flatMap(() => Effect.die(new Error("A exploded"))),
            )
          }
          if (input.parts[0]?.type === "text" && input.parts[0].text === "retry A") {
            return Effect.promise(() => retry.promise).pipe(Effect.as(reply(input, "A recovered")))
          }
          if (input.parts[0]?.type === "text" && input.parts[0].text === "finish B") {
            return Effect.promise(() => finishB.promise).pipe(Effect.as(reply(input, "B done")))
          }
          return Effect.never
        },
        wake: (_sessionID, admission) =>
          Effect.gen(function* () {
            yield* admission
            wakes++
            if (wakes === 1) {
              firstWoke.resolve()
              yield* Effect.promise(() => releaseFirstWake.promise)
              return
            }
            secondWoke.resolve()
          }),
      }
      const context = taskContext(chat.id, assistant.id, promptOps)
      const launch = (description: string, prompt: string, taskID?: string) =>
        def.execute(
          { description, prompt, subagent_type: "general", background: true, ...(taskID ? { task_id: taskID } : {}) },
          context,
        )

      const a = yield* launch("subagent A", "fail A")
      const b = yield* launch("subagent B", "finish B")
      const d = yield* launch("subagent D", "hold D")
      const activeTasks = `<active_tasks>${JSON.stringify([
        { task_id: b.metadata.sessionId, description: "subagent B" },
        { task_id: d.metadata.sessionId, description: "subagent D" },
      ])}</active_tasks>`

      fail.resolve()
      const failed = yield* Effect.promise(() => firstNotification.promise)
      expect(failed.parts[0]?.type).toBe("text")
      if (failed.parts[0]?.type !== "text") throw new Error("background failure notification text not found")
      expect(failed.parts[0].text).toContain(`<task id="${a.metadata.sessionId}" state="error">`)
      expect(failed.parts[0].text).toContain("A exploded")
      expect(failed.parts[0].text).toContain(activeTasks)
      expect(failed.parts[0].text).toContain(`relaunch it with task_id="${a.metadata.sessionId}"`)
      expect(failed.noReply).toBe(true)
      yield* Effect.promise(() => firstWoke.promise).pipe(Effect.timeout("1 second"))
      const failedAcknowledgements = (yield* sessions.messages({ sessionID: chat.id }).pipe(Effect.orDie)).flatMap(
        (message) =>
          message.parts.filter(
            (part) =>
              part.type === "text" &&
              part.synthetic &&
              part.ignored &&
              part.text.startsWith("Background task failed:"),
          ),
      )
      expect(failedAcknowledgements).toEqual([
        expect.objectContaining({
          text: "Background task failed: subagent A. Still running: subagent B, subagent D.",
        }),
      ])
      expect(wakes).toBe(1)

      const restarted = yield* launch("subagent A", "retry A", a.metadata.sessionId)
      expect(restarted.metadata.sessionId).toBe(a.metadata.sessionId)
      expect((yield* jobs.get(a.metadata.sessionId))?.status).toBe("running")
      expect((yield* jobs.get(b.metadata.sessionId))?.status).toBe("running")
      expect((yield* jobs.get(d.metadata.sessionId))?.status).toBe("running")

      releaseFirstWake.resolve()
      finishB.resolve()
      const completed = yield* Effect.promise(() => secondNotification.promise)
      expect(completed.parts[0]?.type).toBe("text")
      if (completed.parts[0]?.type !== "text") throw new Error("background completion notification text not found")
      expect(completed.parts[0].text).toContain(`<task id="${b.metadata.sessionId}" state="completed">`)
      expect(completed.parts[0].text).toContain(
        `<active_tasks>${JSON.stringify([
          { task_id: d.metadata.sessionId, description: "subagent D" },
          { task_id: restarted.metadata.sessionId, description: "subagent A" },
        ])}</active_tasks>`,
      )
      expect(completed.noReply).toBe(true)
      yield* Effect.promise(() => secondWoke.promise).pipe(Effect.timeout("1 second"))
      const acknowledgements = (yield* sessions.messages({ sessionID: chat.id }).pipe(Effect.orDie)).flatMap(
        (message) =>
          message.parts.filter((part) => part.type === "text" && part.synthetic && part.ignored),
      )
      expect(acknowledgements).toHaveLength(2)
      expect(acknowledgements).toContainEqual(
        expect.objectContaining({
          text: "Background task completed: subagent B. Still running: subagent D, subagent A.",
        }),
      )
      expect(notifications).toBe(2)
      expect(wakes).toBe(2)
    }),
  )

  background.instance("background task completion waits for running updates", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const updated = defer<SessionPrompt.PromptInput>()
      const injected = defer<SessionPrompt.PromptInput>()
      let prompts = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            injected.resolve(input)
            return Effect.succeed(reply(input, "done"))
          }
          prompts++
          if (prompts === 1) return Effect.promise(() => first.promise).pipe(Effect.as(reply(input, "first done")))
          updated.resolve(input)
          return Effect.promise(() => second.promise).pipe(Effect.as(reply(input, "second done")))
        },
      }
      const context = taskContext(chat.id, assistant.id, promptOps)

      const started = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      const result = yield* def.execute(
        {
          description: "add investigation scope",
          prompt: "also inspect cancellation",
          subagent_type: "general",
          task_id: started.metadata.sessionId,
        },
        context,
      )

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(result.output).toContain("Background task updated")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const waited = yield* jobs.wait({ id: started.metadata.sessionId, timeout: 1_000 })
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks complete through the background job service", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: { promptOps: stubOps({ text: "background done" }) },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("background done")
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps({ text: "background done" }),
              prompt: (input) =>
                input.sessionID === chat.id ? Effect.never : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("removing the child task session cancels its running background task", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* sessions.remove(result.metadata.sessionId)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          background: true,
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          extra: {
            promptOps: {
              ...stubOps(),
              prompt: () => Effect.never,
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      const waited = yield* jobs.wait({ id: result.metadata.sessionId, timeout: 1_000 })
      expect(waited.timedOut).toBe(false)
      expect(waited.info?.status).toBe("cancelled")
    }),
  )

  background.instance("task_stop cancels selected owned tasks and leaves siblings running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const stop = yield* TaskStopTool
      const def = yield* stop.init()
      const start = Effect.fnUntraced(function* (title: string) {
        const child = yield* sessions.create({ parentID: chat.id, title })
        yield* jobs.start({
          id: child.id,
          type: TaskTool.id,
          title,
          metadata: { parentSessionId: chat.id, sessionId: child.id, background: true },
          run: Effect.never,
        })
        return child
      })
      const a = yield* start("subagent A")
      const b = yield* start("subagent B")
      const d = yield* start("subagent D")
      const context = taskContext(chat.id, assistant.id, {
        ...stubOps(),
        cancel: (sessionID) => runState.cancel(sessionID),
      })

      const result = yield* def.execute({ task_ids: [a.id, b.id, a.id] }, context)

      expect(result.metadata.statuses).toEqual([
        { task_id: a.id, status: "cancelled" },
        { task_id: b.id, status: "cancelled" },
      ])
      expect(result.metadata.active_tasks).toEqual([{ task_id: d.id, description: "subagent D" }])
      expect((yield* jobs.get(d.id))?.status).toBe("running")

      const repeated = yield* def.execute({ task_ids: [a.id] }, context)
      expect(repeated.metadata.statuses).toEqual([{ task_id: a.id, status: "cancelled" }])
      expect(repeated.metadata.active_tasks).toEqual([{ task_id: d.id, description: "subagent D" }])
    }),
  )

  background.instance("task_stop rejects a mixed foreign batch atomically", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const foreign = yield* sessions.create({ title: "Other parent" })
      const ownChild = yield* sessions.create({ parentID: chat.id, title: "Owned child" })
      const foreignChild = yield* sessions.create({ parentID: foreign.id, title: "Foreign child" })
      yield* Effect.forEach(
        [
          [chat.id, ownChild],
          [foreign.id, foreignChild],
        ] as const,
        ([parentID, child]) =>
          jobs.start({
            id: child.id,
            type: TaskTool.id,
            title: child.title,
            metadata: { parentSessionId: parentID, sessionId: child.id, background: true },
            run: Effect.never,
          }),
        { discard: true },
      )
      const stop = yield* TaskStopTool
      const def = yield* stop.init()

      const exit = yield* def
        .execute(
          { task_ids: [ownChild.id, foreignChild.id] },
          taskContext(chat.id, assistant.id, {
            ...stubOps(),
            cancel: (sessionID) => runState.cancel(sessionID),
          }),
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* jobs.get(ownChild.id))?.status).toBe("running")
      expect((yield* jobs.get(foreignChild.id))?.status).toBe("running")
    }),
  )

  background.instance("task_stop allows a cancelled task to relaunch with the same task_id", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const task = yield* TaskTool
      const taskDef = yield* task.init()
      const stop = yield* TaskStopTool
      const stopDef = yield* stop.init()
      let childPrompts = 0
      let wakes = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        cancel: (sessionID) => runState.cancel(sessionID),
        prompt: (input) => {
          if (input.sessionID === chat.id) return Effect.succeed(reply(input, "acknowledged"))
          childPrompts++
          if (childPrompts === 1) return Effect.never
          return Effect.succeed(reply(input, "restarted"))
        },
        wake: (_sessionID, admission) =>
          Effect.sync(() => {
            wakes++
          }).pipe(Effect.andThen(admission)),
      }
      const context = taskContext(chat.id, assistant.id, promptOps)
      const started = yield* taskDef.execute(
        { description: "subagent A", prompt: "run A", subagent_type: "general", background: true },
        context,
      )

      yield* stopDef.execute({ task_ids: [started.metadata.sessionId] }, context)
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("cancelled")
      expect(wakes).toBe(0)

      const restarted = yield* taskDef.execute(
        {
          description: "subagent A",
          prompt: "retry A",
          subagent_type: "general",
          background: true,
          task_id: started.metadata.sessionId,
        },
        context,
      )
      const waited = yield* jobs.wait({ id: restarted.metadata.sessionId, timeout: 1_000 })

      expect(restarted.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(waited.info?.status).toBe("completed")
      expect(waited.info?.output).toBe("restarted")
      expect(wakes).toBe(1)
    }),
  )

  it.instance("cancelling a child run cancels its own pre-runner task job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })

      yield* runState.cancel(child.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("cancelling a parent run recursively cancels descendant background tasks", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })

      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id, sessionId: child.id },
        run: Effect.never,
      })
      yield* jobs.start({
        id: grandchild.id,
        type: "task",
        metadata: { parentSessionId: child.id, sessionId: grandchild.id },
        run: Effect.never,
      })

      yield* runState.cancel(chat.id)

      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
    }),
  )
})
