import { afterEach, describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "@/background/job"
import { BackgroundTaskExecution } from "@/background/task-execution"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Session } from "@/session/session"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"

import {
  TaskStopTool,
  TaskTool,
  deliverBackgroundTerminal,
  startBackgroundTerminalPump,
  type TaskPromptOps,
} from "../../src/tool/task"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Runner } from "@/effect/runner"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { projectBackgroundTasks } from "@/cli/cmd/run/background-tasks"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const provider = ProviderTest.fake({
  model: ProviderTest.model({
    providerID: ref.providerID,
    id: ref.modelID,
    variants: { high: {}, max: {} },
  }),
})

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Provider.node,
      BackgroundJob.node,
      BackgroundTaskExecution.node,
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
      Permission.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [
      [Provider.node, provider.layer],
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
    ],
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

const waitForTerminalExecution = Effect.fn("TaskToolTest.waitForTerminalExecution")(function* (sessionID: SessionID) {
  const executions = yield* BackgroundTaskExecution.Service
  const deadline = Date.now() + 1_000
  while (true) {
    const execution = yield* executions.get(sessionID)
    if (execution && execution.state !== "running") return execution
    if (Date.now() >= deadline) return yield* Effect.fail(new Error(`task ${sessionID} did not settle`))
    yield* Effect.sleep("5 millis")
  }
})

const waitForJobEviction = Effect.fn("TaskToolTest.waitForJobEviction")(function* (id: string) {
  const jobs = yield* BackgroundJob.Service
  const deadline = Date.now() + 1_000
  while (yield* jobs.get(id)) {
    if (Date.now() >= deadline) return yield* Effect.fail(new Error(`task ${id} was not evicted`))
    yield* Effect.sleep("5 millis")
  }
})

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
    interrupt: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done")
      }),
    wake: () => Effect.void,
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

        expect((yield* registry.tools({ ...ref, agent: omni })).some((tool) => tool.id === TaskStopTool.id)).toBe(true)

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
          .execute({ task_ids: [grandchild.id] }, { ...taskContext(child.id, assistant.id, promptOps), agent: "omni" })
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
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        agent: "general",
        model: {
          providerID: ProviderV2.ID.make("openrouter"),
          id: ModelV2.ID.make("anthropic/claude-3-opus"),
          variant: "high",
        },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const calls: unknown[] = []
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
          extra: { promptOps, bypassAgentCheck: true },
          messages: [],
          metadata: () => Effect.void,
          ask: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }),
        },
      )

      const kids = yield* sessions.children(chat.id)
      expect(kids).toHaveLength(1)
      expect(kids[0]?.id).toBe(child.id)
      expect(result.metadata.sessionId).toBe(child.id)
      expect(result.output).toContain(`<task state="completed">`)
      expect(result.output).not.toContain(`<task id=`)
      expect(seen?.sessionID).toBe(child.id)
      expect(seen?.model).toEqual({
        providerID: ProviderV2.ID.make("openrouter"),
        modelID: ModelV2.ID.make("anthropic/claude-3-opus"),
      })
      expect(seen?.variant).toBe("high")
      expect(calls).toEqual([
        {
          permission: "model_override",
          patterns: ["openrouter/anthropic/claude-3-opus"],
          always: ["openrouter/anthropic/claude-3-opus"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
            model: "openrouter/anthropic/claude-3-opus",
          },
        },
      ])
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

  it.instance("defaults model overrides to ask", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = yield* agents.get("build")
      expect(Permission.evaluate("model_override", "test/override", build!.permission).action).toBe("ask")
    }),
  )

  background.instance(
    "uses an explicit model override in background after requesting permission before task permission",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const calls: unknown[] = []
        const ready = defer<SessionPrompt.PromptInput>()

        const result = yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/override",
          },
          {
            ...taskContext(
              chat.id,
              assistant.id,
              stubOps({
                onPrompt: (input) => {
                  ready.resolve(input)
                },
              }),
            ),
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

        expect(`${result.metadata.model.providerID}/${result.metadata.model.modelID}`).toBe("test/override")
        const prompt = yield* Effect.promise(() => ready.promise)
        expect((yield* waitForTerminalExecution(result.metadata.sessionId)).state).toBe("completed")

        expect(calls).toEqual([
          {
            permission: "model_override",
            patterns: ["test/override"],
            always: ["test/override"],
            metadata: {
              description: "inspect bug",
              subagent_type: "general",
              model: "test/override",
            },
          },
          {
            permission: "task",
            patterns: ["general"],
            always: ["*"],
            metadata: {
              description: "inspect bug",
              subagent_type: "general",
            },
          },
        ])
        expect(`${prompt.model?.providerID}/${prompt.model?.modelID}`).toBe("test/override")
        expect(prompt.variant).toBe("default")
      }),
  )

  background.instance("propagates an explicit model variant to the child session and prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = defer<SessionPrompt.PromptInput>()

      const result = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model: "test/test-model",
          variant: "high",
          background: true,
        },
        taskContext(
          chat.id,
          assistant.id,
          stubOps({
            onPrompt: (input) => ready.resolve(input),
          }),
        ),
      )

      const prompt = yield* Effect.promise(() => ready.promise)
      yield* waitForTerminalExecution(result.metadata.sessionId)
      const child = yield* sessions.get(result.metadata.sessionId)

      expect(child?.model?.variant).toBe("high")
      expect(prompt.variant).toBe("high")
    }),
  )

  it.instance("propagates an explicit variant when resuming a task session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({
        parentID: chat.id,
        title: "Existing child",
        agent: "general",
        model: { providerID: ref.providerID, id: ref.modelID, variant: "high" },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let seen: SessionPrompt.PromptInput | undefined
      const calls: unknown[] = []
      const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "resume with max effort",
          subagent_type: "general",
          task_id: child.id,
          variant: "max",
        },
        {
          ...taskContext(chat.id, assistant.id, promptOps),
          extra: { promptOps, bypassAgentCheck: true },
          ask: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }),
        },
      )

      expect(seen?.variant).toBe("max")
      expect(calls).toEqual([
        {
          permission: "model_override",
          patterns: ["test/test-model"],
          always: ["test/test-model"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
            model: "test/test-model",
            variant: "max",
          },
        },
      ])
    }),
  )

  it.instance("rejects an explicit variant that the selected model does not provide", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/test-model",
            variant: "unsupported",
          },
          {
            ...taskContext(chat.id, assistant.id, stubOps()),
            ask: () => Effect.sync(() => (asked = true)),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(asked).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
    }),
  )

  it.instance("requests model override permission even when task permission is bypassed", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []

      yield* def.execute(
        {
          description: "inspect bug",
          prompt: "look into the cache key path",
          subagent_type: "general",
          model: "test/override",
        },
        {
          ...taskContext(chat.id, assistant.id, stubOps()),
          extra: { bypassAgentCheck: true, promptOps: stubOps() },
          ask: (input) =>
            Effect.sync(() => {
              calls.push(input)
            }),
        },
      )

      expect(calls).toEqual([
        {
          permission: "model_override",
          patterns: ["test/override"],
          always: ["test/override"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
            model: "test/override",
          },
        },
      ])
    }),
  )

  it.instance(
    "uses the configured subagent model when an explicit override is omitted",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
          },
          taskContext(chat.id, assistant.id, stubOps({ onPrompt: (input) => (seen = input) })),
        )

        expect(`${seen?.model?.providerID}/${seen?.model?.modelID}`).toBe("test/configured")
        expect(seen?.variant).toBeUndefined()
      }),
    { config: { agent: { general: { model: "test/configured" } } } },
  )

  it.instance("rejects empty and invalid models before requesting permissions", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const input = {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      }
      const context = {
        ...taskContext(chat.id, assistant.id, stubOps()),
        ask: () => Effect.sync(() => (asked = true)),
      }

      for (const model of [
        "",
        "invalid",
        "provider/",
        "/model",
        "provider//model",
        "provider/model/",
        "provider /model",
      ]) {
        expect(Exit.isFailure(yield* def.execute({ ...input, model }, context).pipe(Effect.exit))).toBe(true)
      }
      expect(asked).toBe(false)
    }),
  )

  it.instance("rejecting model_override prevents task permission and child creation", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const calls: unknown[] = []
      let prompted = false

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            model: "test/override",
          },
          {
            ...taskContext(chat.id, assistant.id, stubOps({ onPrompt: () => (prompted = true) })),
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }).pipe(Effect.andThen(Effect.die(new Error("model override denied")))),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(calls).toEqual([
        {
          permission: "model_override",
          patterns: ["test/override"],
          always: ["test/override"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
            model: "test/override",
          },
        },
      ])
      expect(prompted).toBe(false)
      expect(yield* sessions.children(chat.id)).toHaveLength(0)
      expect(yield* jobs.list()).toHaveLength(0)
    }),
  )

  it.instance("once re-asks a resumed model override while always reuses the exact approval", () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps = stubOps()
      const context = {
        ...taskContext(chat.id, assistant.id, promptOps),
        extra: { promptOps, bypassAgentCheck: true },
        ask: (input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
          permission
            .ask({ ...input, sessionID: chat.id, ruleset: [] })
            .pipe(Effect.catch((error) => Effect.die(error))),
      }
      const pending = Effect.fnUntraced(function* () {
        while (true) {
          const requests = yield* permission.list()
          const request = requests.at(0)
          if (request) return request
          yield* Effect.yieldNow
        }
      })

      const first = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "first dispatch",
            subagent_type: "general",
            model: "test/override",
          },
          context,
        )
        .pipe(Effect.forkChild)
      const once = yield* pending().pipe(Effect.timeout("1 second"))
      expect(once.permission).toBe("model_override")
      yield* permission.reply({ requestID: once.id, reply: "once" })
      const firstResult = yield* Fiber.join(first)

      const second = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "second dispatch",
            subagent_type: "general",
            task_id: firstResult.metadata.sessionId,
          },
          context,
        )
        .pipe(Effect.forkChild)
      const always = yield* pending().pipe(Effect.timeout("1 second"))
      expect(always.permission).toBe("model_override")
      expect(always.patterns).toEqual(["test/override"])
      yield* permission.reply({ requestID: always.id, reply: "always" })
      yield* Fiber.join(second)

      const third = yield* def.execute(
        {
          description: "inspect bug",
          prompt: "third dispatch",
          subagent_type: "general",
          task_id: firstResult.metadata.sessionId,
        },
        context,
      )
      expect(third.metadata.sessionId).toBe(firstResult.metadata.sessionId)
      expect(yield* permission.list()).toHaveLength(0)
    }),
  )

  it.instance(
    "trusts a resumed configured agent model and preserves its variant",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({
          parentID: chat.id,
          title: "Configured child",
          agent: "general",
          model: {
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("configured"),
            variant: "high",
          },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const calls: unknown[] = []
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "resume configured",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            ...taskContext(chat.id, assistant.id, promptOps),
            extra: { promptOps, bypassAgentCheck: true },
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

        expect(calls).toEqual([])
        expect(seen?.model).toEqual({
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("configured"),
        })
        expect(seen?.variant).toBe("high")
      }),
    { config: { agent: { general: { model: "test/configured", variant: "high" } } } },
  )

  it.instance(
    "preserves a resumed default variant and reauthorizes it against the configured agent variant",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({
          parentID: chat.id,
          title: "Configured child",
          agent: "general",
          model: {
            providerID: ProviderV2.ID.make("test"),
            id: ModelV2.ID.make("configured"),
            variant: "default",
          },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const calls: unknown[] = []
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "resume configured",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            ...taskContext(chat.id, assistant.id, promptOps),
            extra: { promptOps, bypassAgentCheck: true },
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

        expect(calls).toEqual([
          {
            permission: "model_override",
            patterns: ["test/configured"],
            always: ["test/configured"],
            metadata: {
              description: "inspect bug",
              subagent_type: "general",
              model: "test/configured",
            },
          },
        ])
        expect(seen?.variant).toBe("default")
      }),
    { config: { agent: { general: { model: "test/configured", variant: "high" } } } },
  )

  it.instance(
    "uses the configured agent model as the sole trust root for resumed tasks",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({
          parentID: chat.id,
          title: "Parent-model child",
          agent: "general",
          model: {
            providerID: ref.providerID,
            id: ref.modelID,
            variant: "xhigh",
          },
        })
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const calls: unknown[] = []
        const promptOps = stubOps()

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "resume configured",
            subagent_type: "general",
            task_id: child.id,
          },
          {
            ...taskContext(chat.id, assistant.id, promptOps),
            extra: { promptOps, bypassAgentCheck: true },
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

        expect(calls).toEqual([
          expect.objectContaining({
            permission: "model_override",
            patterns: ["test/test-model"],
          }),
        ])
      }),
    { config: { agent: { general: { model: "test/configured", variant: "high" } } } },
  )

  it.instance(
    "does not authorize an explicit default variant matching the configured agent model",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const calls: unknown[] = []
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (input) => (seen = input) })

        yield* def.execute(
          {
            description: "inspect bug",
            prompt: "use configured",
            subagent_type: "general",
            model: "test/configured",
          },
          {
            ...taskContext(chat.id, assistant.id, promptOps),
            extra: { promptOps, bypassAgentCheck: true },
            ask: (input) =>
              Effect.sync(() => {
                calls.push(input)
              }),
          },
        )

        expect(calls).toEqual([])
        expect(seen?.variant).toBe("default")
      }),
    { config: { agent: { general: { model: "test/configured" } } } },
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
        interrupt: () => Effect.void,
        resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
        prompt: (input) =>
          Effect.promise(() => {
            ready.resolve(input)
            return cancelled.promise
          }).pipe(Effect.as(reply(input, "cancelled"))),
        wake: () => Effect.void,
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

  it.instance("cancels the child session when foreground task execution fails", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let childID: SessionID | undefined
      let cancelled: SessionID | undefined
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        cancel: (sessionID) =>
          Effect.sync(() => {
            cancelled = sessionID
          }),
        prompt: () => Effect.die(new Error("child provider defect")),
      }

      const exit = yield* def
        .execute(
          {
            description: "inspect bug",
            prompt: "look into the cache key path",
            subagent_type: "general",
            background: false,
          },
          {
            ...taskContext(chat.id, assistant.id, promptOps),
            metadata: (input) =>
              Effect.sync(() => {
                if (typeof input.metadata?.sessionId === "string") childID = SessionID.make(input.metadata.sessionId)
              }),
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(childID).toBeDefined()
      expect(cancelled).toBe(childID)
      if (!childID) throw new Error("child session metadata was not captured")
      expect((yield* jobs.get(childID))?.status).not.toBe("running")
      expect((yield* sessions.get(childID)).parentID).toBe(chat.id)
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
      expect(result.output).toContain(`<task state="completed">`)
      expect(result.output).not.toContain(`<task id=`)
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

  it.instance("fails promptly when session ancestry contains a cycle", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { chat, assistant } = yield* seed()
      yield* database.db
        .update(SessionTable)
        .set({ parent_id: chat.id })
        .where(eq(SessionTable.id, chat.id))
        .run()
        .pipe(Effect.orDie)
      const tool = yield* TaskTool
      const def = yield* tool.init()
      let asked = false

      const result = yield* def
        .execute(
          {
            description: "inspect cycle",
            prompt: "do not run",
            subagent_type: "general",
          },
          {
            ...taskContext(chat.id, assistant.id, stubOps()),
            ask: () =>
              Effect.sync(() => {
                asked = true
              }),
          },
        )
        .pipe(Effect.exit, Effect.timeoutOption("1 second"))

      expect(result._tag).toBe("Some")
      if (result._tag === "Some") expect(Exit.isFailure(result.value)).toBe(true)
      expect(asked).toBe(false)
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
        expect(child.title).toBe("(subagente) Pinned")
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
        interrupt: () => Effect.void,
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
        wake: () => Effect.void,
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
      expect((yield* waitForTerminalExecution(result.metadata.sessionId)).output).toBe("background done")
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

  background.instance("background task fails when its child assistant errors without text", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) return Effect.succeed(reply(input, "notified"))
          const failed = reply(input, "")
          return Effect.succeed({
            info: {
              ...failed.info,
              error: MessageV2.fromError(new Error("child provider failed"), { providerID: ref.providerID }),
            },
            parts: [],
          })
        },
      }

      const result = yield* def.execute(
        {
          description: "inspect failure",
          prompt: "find the issue",
          subagent_type: "general",
          background: true,
        },
        taskContext(chat.id, assistant.id, promptOps),
      )
      const terminal = yield* waitForTerminalExecution(result.metadata.sessionId)

      expect(terminal.state).toBe("error")
      expect(terminal.error).toContain("child provider failed")
      expect(terminal.output).toBeUndefined()
    }),
  )

  background.instance("re-enters durable terminal handling when a local running job is already inactive", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
      const jobs = yield* BackgroundJob.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => (input.sessionID === chat.id ? Effect.succeed(reply(input, "notified")) : Effect.never),
      }
      const params = {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
        background: true,
      } as const

      const started = yield* def.execute(params, {
        ...taskContext(chat.id, assistant.id, promptOps),
        callID: "call-1",
      })
      const generation = started.metadata.backgroundTaskGeneration
      if (!generation) throw new Error("background task generation was not recorded")
      const settled = yield* executions.settle({
        sessionID: started.metadata.sessionId,
        generation,
        state: "completed",
        output: "settled remotely",
      })
      if (!settled) throw new Error("durable execution did not settle")
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")

      const relaunched = yield* def.execute(
        { ...params, task_id: started.metadata.sessionId },
        { ...taskContext(chat.id, assistant.id, promptOps), callID: "call-2" },
      )

      expect(relaunched.metadata.backgroundTaskGeneration).toBe(`${assistant.id}:call-2`)
      expect(relaunched.output).toContain(`state="running"`)
      yield* runState.cancel(relaunched.metadata.sessionId)
    }),
  )

  background.instance("explicit background false stays foreground", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
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
      expect((yield* sessions.get(result.metadata.sessionId)).parentID).toBe(chat.id)
    }),
  )

  background.instance("waits for descendant handoffs and returns the latest child response", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const ready = yield* Deferred.make<{ parentID: SessionID; sessionID: SessionID; generation: string }>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) return Effect.succeed(reply(input, "notified"))
          return Effect.gen(function* () {
            const descendant = yield* sessions.create({ parentID: input.sessionID, title: "nested review" })
            const generation = "nested-generation"
            yield* executions.claim({
              sessionID: descendant.id,
              parentSessionID: input.sessionID,
              generation,
              description: descendant.title,
              parentMessageID: input.messageID ?? MessageID.ascending(),
              wakeRequired: true,
            })
            yield* Deferred.succeed(ready, { parentID: input.sessionID, sessionID: descendant.id, generation })
            return reply(input, "review still in progress")
          })
        },
      }
      const fiber = yield* def
        .execute(
          {
            description: "complete nested review",
            prompt: "review everything",
            subagent_type: "general",
            background: false,
          },
          taskContext(chat.id, assistant.id, promptOps),
        )
        .pipe(Effect.forkChild)
      const descendant = yield* Deferred.await(ready)

      expect((yield* Fiber.await(fiber).pipe(Effect.timeoutOption("20 millis")))._tag).toBe("None")
      const terminal = yield* executions.settle({
        sessionID: descendant.sessionID,
        generation: descendant.generation,
        state: "completed",
        output: "nested done",
      })
      if (!terminal) throw new Error("nested terminal missing")
      const delivery = yield* executions.claimDelivery({
        sessionID: descendant.sessionID,
        generation: descendant.generation,
      })
      if (!delivery) throw new Error("descendant terminal delivery was not claimed")
      yield* executions.completeDelivery({
        sessionID: descendant.sessionID,
        generation: descendant.generation,
        token: delivery.token,
      })
      const wake = yield* executions.claimWake({
        sessionID: descendant.sessionID,
        generation: descendant.generation,
      })
      if (!wake) throw new Error("descendant terminal wake was not claimed")
      const time = Date.now()
      const final = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: terminal.delivery.messageID,
        sessionID: descendant.parentID,
        mode: "general",
        agent: "general",
        finish: "stop",
        time: { created: time, completed: time },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: final.id,
        sessionID: final.sessionID,
        type: "text",
        text: "final response after descendants",
      })
      yield* executions.completeWake({
        sessionID: descendant.sessionID,
        generation: descendant.generation,
        token: wake.token,
      })

      const result = yield* Fiber.join(fiber).pipe(Effect.timeout("1 second"))
      expect(result.output).toContain("final response after descendants")
      expect(yield* executions.get(descendant.parentID)).toMatchObject({
        state: "completed",
        output: "final response after descendants",
      })
    }),
  )

  background.instance("completed background tasks notify with the remaining parallel tasks", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
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
      const wakeStarted = defer<void>()
      const releaseWake = defer<void>()
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
        wake: () =>
          Effect.promise(() => {
            wakeStarted.resolve()
            return releaseWake.promise
          }),
      }
      const context = taskContext(chat.id, assistant.id, promptOps)
      const launch = (description: string, prompt: string) =>
        def.execute({ description, prompt, subagent_type: "general", background: true }, context)

      const a = yield* launch("subagent A", "run A")
      const b = yield* launch("subagent B", "hold B")
      const d = yield* launch("subagent D", "hold D")
      const detail: SessionV1.Assistant = {
        ...assistant,
        id: MessageID.ascending(),
        parentID: MessageID.ascending(),
        sessionID: a.metadata.sessionId,
        agent: "general",
        mode: "general",
      }
      yield* sessions.updateMessage(detail)
      const detailPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: detail.id,
        sessionID: detail.sessionID,
        type: "text",
        text: "retained child detail",
      })
      const launchPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "launch-a",
        tool: "task",
        state: {
          status: "completed",
          input: { description: "subagent A" },
          title: a.title,
          output: a.output,
          metadata: a.metadata,
          time: { start: Date.now(), end: Date.now() },
        },
      })
      yield* jobs.start({
        id: "other-parent-task",
        type: "task",
        title: "other task",
        metadata: { parentSessionId: other.id },
        run: Effect.never,
      })

      completed.resolve()
      const injected = yield* Effect.promise(() => notification.promise)
      yield* Effect.promise(() => wakeStarted.promise)
      expect((yield* sessions.get(a.metadata.sessionId)).parentID).toBe(chat.id)
      releaseWake.resolve()
      expect(injected.parts[0]?.type).toBe("text")
      if (injected.parts[0]?.type !== "text") throw new Error("background notification text not found")
      expect(injected.parts[0].text).toContain(`<task state="completed">`)
      expect(injected.parts[0].text).not.toContain(`<task id=`)
      expect(injected.parts[0].text).toContain(
        `<active_tasks>${JSON.stringify([
          { task_id: b.metadata.sessionId, description: "subagent B" },
          { task_id: d.metadata.sessionId, description: "subagent D" },
        ])}</active_tasks>`,
      )
      expect(injected.parts[0].text).not.toContain("other-parent-task")
      expect(injected.parts[0].text).toContain("React to this event now")
      expect(injected.parts[0].text).toContain("Do not poll the active tasks")
      const deadline = Date.now() + 1_000
      while ((yield* executions.get(a.metadata.sessionId))?.wakeClaimedAt === undefined) {
        if (Date.now() >= deadline) yield* Effect.fail(new Error("completed child wake did not finish"))
        yield* Effect.sleep("10 millis")
      }
      expect((yield* sessions.get(a.metadata.sessionId)).parentID).toBe(chat.id)
      expect(
        yield* sessions.getPart({
          sessionID: detailPart.sessionID,
          messageID: detailPart.messageID,
          partID: detailPart.id,
        }),
      ).toEqual(detailPart)
      expect(
        (yield* sessions.messages({ sessionID: a.metadata.sessionId })).some((message) =>
          message.parts.some((part) => part.id === detailPart.id),
        ),
      ).toBe(true)
      expect((yield* sessions.list({ roots: true })).some((item) => item.id === a.metadata.sessionId)).toBe(false)
      expect((yield* sessions.list()).some((item) => item.id === a.metadata.sessionId)).toBe(true)
      const persisted = yield* sessions.getPart({
        sessionID: launchPart.sessionID,
        messageID: launchPart.messageID,
        partID: launchPart.id,
      })
      expect(persisted?.type).toBe("tool")
      if (persisted?.type === "tool" && persisted.state.status === "completed") {
        expect(persisted.state.metadata?.sessionId).toBe(a.metadata.sessionId)
        expect(persisted.state.metadata?.jobId).toBe(a.metadata.sessionId)
        expect(persisted.state.output).toContain(`<task id="${a.metadata.sessionId}"`)
      }
      expect((yield* jobs.get(b.metadata.sessionId))?.status).toBe("running")
      expect((yield* jobs.get(d.metadata.sessionId))?.status).toBe("running")
    }),
  )

  background.instance("completed exact-generation replay stays terminal in the durable CLI projection", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "replayed child" })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const callID = "replayed-call"
      const generation = `${assistant.id}:${callID}`
      const replayPartID = PartID.ascending()
      const terminals: SessionPrompt.PromptInput["parts"][number][] = []
      const promptOps = stubOps({
        onPrompt: (input) => {
          if (input.sessionID === chat.id) terminals.push(...input.parts)
        },
      })
      const params = {
        description: child.title,
        prompt: "already completed",
        subagent_type: "general",
        background: true,
        task_id: child.id,
      } as const
      const context = { ...taskContext(chat.id, assistant.id, promptOps), callID }

      yield* executions.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation,
        description: child.title,
        parentMessageID: assistant.id,
        wakeRequired: true,
      })
      yield* executions.settle({
        sessionID: child.id,
        generation,
        state: "completed",
        output: "durable result",
      })

      const first = yield* def.execute(params, context)
      const second = yield* def.execute(params, context)

      expect(first.metadata).toMatchObject({
        background: true,
        jobId: child.id,
        sessionId: child.id,
        backgroundTaskGeneration: generation,
        backgroundTaskState: "completed",
        model: { providerID: ref.providerID, modelID: ref.modelID },
      })
      expect(second.metadata).toEqual(first.metadata)
      expect(terminals).toHaveLength(1)

      const messages = [
        {
          info: {},
          parts: [
            {
              id: replayPartID,
              type: "tool",
              tool: "task",
              state: {
                status: "completed",
                input: params,
                output: first.output,
                title: first.title,
                metadata: first.metadata,
                time: { start: 1, end: 2 },
              },
            },
            ...terminals,
          ],
        },
      ]
      expect(projectBackgroundTasks(messages).size).toBe(0)
      expect(projectBackgroundTasks(messages).size).toBe(0)
    }),
  )

  background.instance("escapes dynamic XML framing in terminal notifications", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const release = defer<void>()
      const notification = defer<SessionPrompt.PromptInput>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            notification.resolve(input)
            return Effect.succeed(reply(input, "notified"))
          }
          if (input.parts[0]?.type === "text" && input.parts[0].text === "run escaped") {
            return Effect.promise(() => release.promise).pipe(Effect.as(reply(input, "<result>&")))
          }
          return Effect.never
        },
      }
      const context = taskContext(chat.id, assistant.id, promptOps)

      yield* def.execute(
        { description: "<review>&", prompt: "run escaped", subagent_type: "general", background: true },
        context,
      )
      yield* def.execute(
        { description: "<sibling>&", prompt: "hold sibling", subagent_type: "general", background: true },
        context,
      )
      release.resolve()

      const admitted = yield* Effect.promise(() => notification.promise).pipe(Effect.timeout("1 second"))
      const part = admitted.parts[0]
      if (part?.type !== "text") throw new Error("background notification text not found")
      expect(part.text).toContain("Background task completed: &lt;review&gt;&amp;")
      expect(part.text).toContain("&lt;result&gt;&amp;")
      expect(part.text).toContain('"description":"&lt;sibling&gt;&amp;"')
      expect(part.text).not.toContain("<review>")
      expect(part.text).not.toContain("<result>")
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
        wake: (sessionID: SessionID) =>
          Effect.sync(() => {
            wakeCalls.push(sessionID)
            if (wakeCalls.length === 1) firstWoke.resolve()
            if (wakeCalls.length === 2) woke.resolve()
          }),
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
          message.parts.some(
            (part) => part.type === "text" && part.synthetic && part.text.includes('<task state="completed">'),
          ),
      )
      const acknowledgements = messages.filter((message) => {
        const info = message.info
        if (info.role !== "assistant") return false
        return notifications.some((notification) => notification.info.id === info.parentID)
      })
      expect(notifications).toHaveLength(2)
      expect(acknowledgements).toHaveLength(2)
      expect(acknowledgements.map((message) => message.parts.find((part) => part.type === "text"))).toEqual(
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

  background.instance("persists a terminal event before a coalesced parent wake", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const runner = Runner.make<void>(scope)
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const currentStarted = yield* Deferred.make<void>()
      const releaseCurrent = yield* Deferred.make<void>()
      const releaseQueued = yield* Deferred.make<void>()
      const terminalWake = yield* Deferred.make<void>()
      let admissions = 0

      const current = yield* runner
        .ensureRunning(Deferred.succeed(currentStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseCurrent))))
        .pipe(Effect.forkChild)
      yield* Deferred.await(currentStarted)
      const queued = yield* runner.wake(Deferred.await(releaseQueued)).pipe(Effect.forkChild)
      while (runner.state._tag !== "RunningThenRun") yield* Effect.yieldNow

      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID !== chat.id) return Effect.succeed(reply(input, "child done"))
          return Effect.sync(() => {
            admissions++
            return reply(input, "terminal admitted")
          })
        },
        wake: () =>
          Deferred.succeed(terminalWake, undefined).pipe(Effect.andThen(runner.wake(Effect.void)), Effect.asVoid),
      }

      yield* def.execute(
        {
          description: "coalesced child",
          prompt: "finish immediately",
          subagent_type: "general",
          background: true,
        },
        taskContext(chat.id, assistant.id, promptOps),
      )
      yield* Deferred.await(terminalWake).pipe(Effect.timeout("1 second"))

      expect(admissions).toBe(1)

      yield* Deferred.succeed(releaseCurrent, undefined)
      yield* Deferred.succeed(releaseQueued, undefined)
      yield* Fiber.join(current)
      yield* Fiber.join(queued)
    }),
  )

  background.instance("persists both simultaneous terminal events even when wakes coalesce", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const first = defer<void>()
      const second = defer<void>()
      const woke = defer<void>()
      let admissions = 0
      let wakes = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            admissions++
            return Effect.succeed(reply(input, "terminal admitted"))
          }
          const gate = input.parts[0]?.type === "text" && input.parts[0].text === "run A" ? first : second
          return Effect.promise(() => gate.promise).pipe(Effect.as(reply(input, "done")))
        },
        wake: () =>
          Effect.sync(() => {
            wakes++
            if (wakes === 2) woke.resolve()
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
      yield* Effect.promise(() => woke.promise).pipe(Effect.timeout("1 second"))

      expect(admissions).toBe(2)
      expect(wakes).toBe(2)
    }),
  )

  background.instance("admits parallel terminals before either parent wake completes", () =>
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
        wake: () =>
          Effect.gen(function* () {
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

      yield* Effect.promise(() => secondAdmitted.promise).pipe(Effect.timeout("1 second"))
      yield* Effect.promise(() => secondWoke.promise).pipe(Effect.timeout("1 second"))
      expect(admissions).toBe(2)
      expect(wakes).toBe(2)

      releaseFirstWake.resolve()
    }),
  )

  background.instance("admits terminal events before a blocked parent wake", () =>
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
            return Effect.promise(() => fail.promise).pipe(Effect.flatMap(() => Effect.die(new Error("A exploded"))))
          }
          return Effect.never
        },
        wake: () =>
          Effect.gen(function* () {
            firstWoke.resolve()
            yield* Effect.promise(() => releaseWake.promise)
          }),
      } satisfies TaskPromptOps
      const context = taskContext(chat.id, assistant.id, promptOps)
      const launch = (description: string, prompt: string) =>
        def.execute({ description, prompt, subagent_type: "general", background: true }, context)

      const a = yield* launch("subagent A", "fail A")
      fail.resolve()
      const admitted = yield* Effect.promise(() => notification.promise).pipe(Effect.timeout("1 second"))
      yield* Effect.promise(() => firstWoke.promise).pipe(Effect.timeout("1 second"))
      expect(admitted.parts[0]?.type).toBe("text")
      if (admitted.parts[0]?.type !== "text") throw new Error("background failure notification text not found")
      expect(admitted.parts[0].text).toContain(`<task id="${a.metadata.sessionId}" state="error">`)
      expect(admitted.parts[0].text).toContain("<active_tasks>[]</active_tasks>")
      releaseWake.resolve()
    }),
  )

  background.instance("preserves a real background failure as error and allows a durable relaunch", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const terminal = yield* Deferred.make<SessionPrompt.PromptInput>()
      const woke = yield* Deferred.make<void>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        cancel: (sessionID) => runState.cancel(sessionID),
        interrupt: (sessionID) => runState.interrupt(sessionID),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(terminal, input).pipe(Effect.as(reply(input, "notified")))
          }
          const text = input.parts[0]?.type === "text" ? input.parts[0].text : ""
          if (text === "fail durably") return Effect.die(new Error("child provider defect"))
          return Effect.never
        },
        wake: () => Deferred.succeed(woke, undefined).pipe(Effect.asVoid),
      }
      const context = taskContext(chat.id, assistant.id, promptOps)

      const failed = yield* def.execute(
        {
          description: "durable failure",
          prompt: "fail durably",
          subagent_type: "general",
          background: true,
        },
        context,
      )
      expect((yield* waitForTerminalExecution(failed.metadata.sessionId)).state).toBe("error")
      const event = yield* Deferred.await(terminal).pipe(Effect.timeout("1 second"))
      yield* Deferred.await(woke).pipe(Effect.timeout("1 second"))

      expect(event.parts[0]).toEqual(
        expect.objectContaining({
          type: "text",
          metadata: expect.objectContaining({
            backgroundTaskID: failed.metadata.sessionId,
            backgroundTaskState: "error",
            backgroundTaskGeneration: failed.metadata.backgroundTaskGeneration,
          }),
        }),
      )
      expect(yield* executions.get(failed.metadata.sessionId)).toMatchObject({
        generation: failed.metadata.backgroundTaskGeneration,
        state: "error",
        error: "child provider defect",
        cancelRequestedAt: undefined,
      })

      const relaunched = yield* def.execute(
        {
          description: "durable failure",
          prompt: "retry durably",
          subagent_type: "general",
          background: true,
          task_id: failed.metadata.sessionId,
        },
        context,
      )
      expect(relaunched.metadata.backgroundTaskGeneration).not.toBe(failed.metadata.backgroundTaskGeneration)
      expect(yield* executions.get(failed.metadata.sessionId)).toMatchObject({
        generation: relaunched.metadata.backgroundTaskGeneration,
        state: "running",
      })
      yield* runState.cancel(relaunched.metadata.sessionId)
    }),
  )

  background.instance(
    "does not deliver an expired terminal across runtimes, but its owner still wakes the parent",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "expired child" })
        let now = 1_000
        const expired = yield* BackgroundTaskExecution.make({
          ownerID: "expired-runtime",
          leaseMillis: 20,
          now: () => now,
        })
        const recovery = yield* BackgroundTaskExecution.make({
          ownerID: "recovery-runtime",
          leaseMillis: 20,
          now: () => now,
        })
        yield* expired.claim({
          sessionID: child.id,
          parentSessionID: chat.id,
          generation: "expired-generation",
          description: child.title,
          parentMessageID: assistant.id,
          parentVariant: "xhigh",
        })
        yield* sessions.removeMessage({ sessionID: chat.id, messageID: assistant.id })
        now = 1_021

        const woke = yield* Deferred.make<void>()
        let admissions = 0
        let wakes = 0
        let variant: string | undefined
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) =>
            Effect.sync(() => {
              admissions++
              variant = input.variant
              return reply(input, "recovered terminal")
            }),
          wake: () =>
            Effect.sync(() => {
              wakes++
            }).pipe(Effect.andThen(Deferred.succeed(woke, undefined)), Effect.asVoid),
        }

        yield* startBackgroundTerminalPump({
          executions: recovery,
          sessions,
          ops: promptOps,
          interval: "5 millis",
        })
        yield* Effect.sleep("20 millis")

        expect(yield* recovery.get(child.id)).toMatchObject({
          generation: "expired-generation",
          state: "error",
          error: "Background task owner lease expired",
        })
        expect(admissions).toBe(0)
        expect(wakes).toBe(0)
        expect(variant).toBeUndefined()

        yield* startBackgroundTerminalPump({
          executions: expired,
          sessions,
          ops: promptOps,
          interval: "5 millis",
        })
        yield* Deferred.await(woke).pipe(Effect.timeout("1 second"))
        yield* Effect.sleep("20 millis")

        expect(admissions).toBe(1)
        expect(wakes).toBe(1)
        expect(variant).toBe("xhigh")
      }),
  )

  background.instance("recovers a legacy terminal variant from its persisted parent message", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "legacy child" })
      const ownership = yield* executions.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "legacy-generation",
        description: child.title,
        parentMessageID: assistant.id,
      })
      if (ownership.status !== "claimed") throw new Error("legacy execution was not claimed")
      const terminal = yield* executions.settle({
        sessionID: child.id,
        generation: "legacy-generation",
        state: "completed",
        output: "done",
      })
      if (!terminal) throw new Error("legacy execution did not settle")
      let variant: string | undefined

      expect(
        yield* deliverBackgroundTerminal({
          executions,
          sessions,
          terminal,
          ops: {
            ...stubOps(),
            prompt: (input) =>
              Effect.sync(() => {
                variant = input.variant
                return reply(input, "recovered")
              }),
          },
        }),
      ).toBe(true)
      expect(variant).toBe("xhigh")
    }),
  )

  background.instance("recovers a wake only from the owning runtime without duplicating the terminal", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "wake recovery" })
      let now = 1_000
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "task-owner", leaseMillis: 20, now: () => now })
      const second = yield* BackgroundTaskExecution.make({ ownerID: "wake-b", leaseMillis: 20, now: () => now })
      yield* owner.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "wake-generation",
        description: child.title,
        parentMessageID: assistant.id,
      })
      const settled = yield* owner.settle({
        sessionID: child.id,
        generation: "wake-generation",
        state: "completed",
        output: "done",
      })
      if (!settled) throw new Error("terminal was not settled")

      let admissions = 0
      const failed = yield* deliverBackgroundTerminal({
        executions: owner,
        sessions,
        terminal: settled,
        ops: {
          ...stubOps(),
          prompt: (input) =>
            Effect.sync(() => {
              admissions++
              return reply(input, "terminal admitted")
            }),
          wake: () => Effect.die(new Error("wake runtime crashed")),
        },
      }).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* owner.get(child.id)).toMatchObject({
        terminalDeliveredAt: expect.any(Number),
        wakeClaimedAt: undefined,
      })

      now = 1_021
      const woke = yield* Deferred.make<void>()
      let wakes = 0
      yield* startBackgroundTerminalPump({
        executions: second,
        sessions,
        ops: {
          ...stubOps(),
          prompt: (input) =>
            Effect.sync(() => {
              admissions++
              return reply(input, "duplicate terminal")
            }),
          wake: () =>
            Effect.sync(() => {
              wakes++
            }).pipe(Effect.andThen(Deferred.succeed(woke, undefined)), Effect.asVoid),
        },
        interval: "5 millis",
      })
      yield* Effect.sleep("20 millis")

      expect(admissions).toBe(1)
      expect(wakes).toBe(0)
      expect(yield* second.get(child.id)).toMatchObject({ wakeClaimedAt: undefined })

      yield* startBackgroundTerminalPump({
        executions: owner,
        sessions,
        ops: {
          ...stubOps(),
          wake: () =>
            Effect.sync(() => {
              wakes++
            }).pipe(Effect.andThen(Deferred.succeed(woke, undefined)), Effect.asVoid),
        },
        interval: "5 millis",
      })
      yield* Deferred.await(woke).pipe(Effect.timeout("1 second"))
      yield* Effect.sleep("20 millis")

      expect(admissions).toBe(1)
      expect(wakes).toBe(1)
      expect(yield* owner.get(child.id)).toMatchObject({ wakeClaimedAt: expect.any(Number) })
    }),
  )

  background.instance("fences a stale terminal-pump delivery after same-runtime reclaim", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("delivery parent")
      const child = yield* sessions.create({ parentID: chat.id, title: "delivery child" })
      let now = 1_000
      const executions = yield* BackgroundTaskExecution.make({
        ownerID: "recovery",
        leaseMillis: 100,
        now: () => now,
      })
      yield* executions.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "delivery-generation",
        description: child.title,
        parentMessageID: assistant.id,
        wakeRequired: true,
      })
      const terminal = yield* executions.settle({
        sessionID: child.id,
        generation: "delivery-generation",
        state: "cancelled",
        error: "cancelled",
      })
      if (!terminal) throw new Error("terminal execution missing")

      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      let prompts = 0
      const ops: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) =>
          Effect.gen(function* () {
            prompts++
            if (prompts === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
              return reply(input, "stale delivery")
            }
            yield* Deferred.succeed(secondStarted, undefined)
            yield* Deferred.await(releaseSecond)
            return reply(input, "replacement delivery")
          }),
      }
      const first = yield* deliverBackgroundTerminal({ executions, sessions, ops, terminal }).pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"))
      now = 1_101
      const second = yield* deliverBackgroundTerminal({ executions, sessions, ops, terminal }).pipe(Effect.forkChild)
      yield* Deferred.await(secondStarted).pipe(Effect.timeout("1 second"))

      yield* Deferred.succeed(releaseFirst, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.timeout("1 second"))).toBe(false)
      expect(yield* executions.get(child.id)).toMatchObject({ terminalDeliveredAt: undefined })

      yield* Deferred.succeed(releaseSecond, undefined)
      expect(yield* Fiber.join(second).pipe(Effect.timeout("1 second"))).toBe(true)
      expect(yield* executions.get(child.id)).toMatchObject({ terminalDeliveredAt: expect.any(Number) })
    }),
  )

  background.instance("fences a stale terminal-pump wake after same-runtime reclaim", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed("wake parent")
      const child = yield* sessions.create({ parentID: chat.id, title: "wake child" })
      let now = 1_000
      const executions = yield* BackgroundTaskExecution.make({
        ownerID: "recovery",
        leaseMillis: 1_000_000,
        now: () => now,
      })
      yield* executions.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "wake-generation",
        description: child.title,
        parentMessageID: assistant.id,
        wakeRequired: true,
      })
      const terminal = yield* executions.settle({
        sessionID: child.id,
        generation: "wake-generation",
        state: "completed",
        output: "done",
      })
      if (!terminal) throw new Error("terminal execution missing")
      const delivery = yield* executions.claimDelivery({ sessionID: child.id, generation: terminal.generation })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* executions.completeDelivery({
        sessionID: child.id,
        generation: terminal.generation,
        token: delivery.token,
      })

      const firstStarted = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const releaseSecond = yield* Deferred.make<void>()
      let wakes = 0
      const ops: TaskPromptOps = {
        ...stubOps(),
        wake: () =>
          Effect.gen(function* () {
            wakes++
            if (wakes === 1) {
              yield* Deferred.succeed(firstStarted, undefined)
              yield* Deferred.await(releaseFirst)
              return
            }
            yield* Deferred.succeed(secondStarted, undefined)
            yield* Deferred.await(releaseSecond)
          }),
      }
      const first = yield* deliverBackgroundTerminal({ executions, sessions, ops, terminal }).pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted).pipe(Effect.timeout("1 second"))
      now = 1_001_001
      const second = yield* deliverBackgroundTerminal({ executions, sessions, ops, terminal }).pipe(Effect.forkChild)
      yield* Deferred.await(secondStarted).pipe(Effect.timeout("1 second"))

      yield* Deferred.succeed(releaseFirst, undefined)
      expect(yield* Fiber.join(first).pipe(Effect.timeout("1 second"))).toBe(false)
      expect(yield* executions.get(child.id)).toMatchObject({ wakeClaimedAt: undefined })

      yield* Deferred.succeed(releaseSecond, undefined)
      expect(yield* Fiber.join(second).pipe(Effect.timeout("1 second"))).toBe(true)
      expect(yield* executions.get(child.id)).toMatchObject({ wakeClaimedAt: expect.any(Number) })
    }),
  )

  background.instance("rehydrates owned terminal work only after each lease expires", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const deliveryParent = yield* seed("delivery parent")
      const wakeParent = yield* seed("wake parent")
      const deliveryChild = yield* sessions.create({ parentID: deliveryParent.chat.id, title: "delivery child" })
      const wakeChild = yield* sessions.create({ parentID: wakeParent.chat.id, title: "wake child" })
      let now = 1_000
      const owner = yield* BackgroundTaskExecution.make({ ownerID: "task-owner", leaseMillis: 20, now: () => now })

      yield* owner.claim({
        sessionID: deliveryChild.id,
        parentSessionID: deliveryParent.chat.id,
        generation: "delivery-generation",
        description: deliveryChild.title,
        parentMessageID: deliveryParent.assistant.id,
        wakeRequired: true,
      })
      yield* owner.settle({
        sessionID: deliveryChild.id,
        generation: "delivery-generation",
        state: "cancelled",
        error: "cancelled",
      })
      yield* owner.claim({
        sessionID: wakeChild.id,
        parentSessionID: wakeParent.chat.id,
        generation: "wake-generation",
        description: wakeChild.title,
        parentMessageID: wakeParent.assistant.id,
        wakeRequired: true,
      })
      yield* owner.settle({
        sessionID: wakeChild.id,
        generation: "wake-generation",
        state: "completed",
        output: "done",
      })
      const wakeDelivery = yield* owner.claimDelivery({ sessionID: wakeChild.id, generation: "wake-generation" })
      if (!wakeDelivery) throw new Error("wake terminal delivery was not claimed")
      yield* owner.completeDelivery({
        sessionID: wakeChild.id,
        generation: "wake-generation",
        token: wakeDelivery.token,
      })

      const hydrations = new Map<SessionID, number>()
      let prompts = 0
      let wakes = 0
      const deliveryReclaimed = yield* Deferred.make<void>()
      const wakeReclaimed = yield* Deferred.make<void>()
      yield* startBackgroundTerminalPump({
        executions: owner,
        sessions,
        ops: {
          ...stubOps(),
          prompt: (input) => {
            const part = input.parts[0]
            if (part?.type !== "text" || part.metadata?.backgroundTaskID !== deliveryChild.id) {
              return Effect.succeed(reply(input, "terminal admitted"))
            }
            prompts++
            if (prompts === 1) return Effect.never
            return Deferred.succeed(deliveryReclaimed, undefined).pipe(Effect.as(reply(input, "delivery reclaimed")))
          },
          wake: (sessionID) => {
            if (sessionID !== wakeParent.chat.id) return Effect.void
            wakes++
            if (wakes === 1) return Effect.never
            return Deferred.succeed(wakeReclaimed, undefined).pipe(Effect.asVoid)
          },
        },
        provide: (terminal, delivery) =>
          Effect.sync(() => hydrations.set(terminal.sessionID, (hydrations.get(terminal.sessionID) ?? 0) + 1)).pipe(
            Effect.andThen(delivery),
          ),
        interval: "5 millis",
      })

      const firstDeadline = Date.now() + 1_000
      while ((hydrations.get(deliveryChild.id) ?? 0) < 1 || (hydrations.get(wakeChild.id) ?? 0) < 1) {
        if (Date.now() >= firstDeadline) yield* Effect.fail(new Error("terminal work was not initially hydrated"))
        yield* Effect.sleep("5 millis")
      }
      yield* Effect.sleep("25 millis")
      expect(hydrations.get(deliveryChild.id)).toBe(1)
      expect(hydrations.get(wakeChild.id)).toBe(1)
      expect(prompts).toBe(1)
      expect(wakes).toBe(1)

      now = 1_021
      yield* Effect.all([Deferred.await(deliveryReclaimed), Deferred.await(wakeReclaimed)], {
        concurrency: "unbounded",
      }).pipe(Effect.timeout("1 second"))
      yield* Effect.sleep("25 millis")

      expect(hydrations.get(deliveryChild.id)).toBe(2)
      expect(hydrations.get(wakeChild.id)).toBe(2)
      expect(prompts).toBe(2)
      expect(wakes).toBe(2)
      expect(yield* owner.get(deliveryChild.id)).toMatchObject({ terminalDeliveredAt: expect.any(Number) })
      expect(yield* owner.get(wakeChild.id)).toMatchObject({ wakeClaimedAt: expect.any(Number) })
    }),
  )

  background.instance("renews a long parent wake without blocking later terminal recovery", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const firstChild = yield* sessions.create({ parentID: chat.id, title: "slow wake" })
      const secondChild = yield* sessions.create({ parentID: chat.id, title: "later terminal" })
      const recovery = yield* BackgroundTaskExecution.make({ ownerID: "wake-owner", leaseMillis: 200 })
      const remote = yield* BackgroundTaskExecution.make({ ownerID: "wake-remote", leaseMillis: 200 })
      const firstTerminal = yield* recovery.claim({
        sessionID: firstChild.id,
        parentSessionID: chat.id,
        generation: "slow-generation",
        description: firstChild.title,
        parentMessageID: assistant.id,
        wakeRequired: true,
      })
      yield* recovery.settle({
        sessionID: firstChild.id,
        generation: firstTerminal.info.generation,
        state: "completed",
        output: "slow done",
      })

      const firstWake = yield* Deferred.make<void>()
      const releaseFirstWake = yield* Deferred.make<void>()
      const secondWake = yield* Deferred.make<void>()
      let wakes = 0
      yield* startBackgroundTerminalPump({
        executions: recovery,
        sessions,
        ops: {
          ...stubOps(),
          wake: () =>
            Effect.gen(function* () {
              wakes++
              if (wakes === 1) {
                yield* Deferred.succeed(firstWake, undefined)
                yield* Deferred.await(releaseFirstWake)
                return
              }
              yield* Deferred.succeed(secondWake, undefined)
            }),
        },
        interval: "5 millis",
      })
      yield* Deferred.await(firstWake).pipe(Effect.timeout("1 second"))

      const secondTerminal = yield* recovery.claim({
        sessionID: secondChild.id,
        parentSessionID: chat.id,
        generation: "later-generation",
        description: secondChild.title,
        parentMessageID: assistant.id,
        wakeRequired: true,
      })
      yield* recovery.settle({
        sessionID: secondChild.id,
        generation: secondTerminal.info.generation,
        state: "completed",
        output: "later done",
      })
      yield* Deferred.await(secondWake).pipe(Effect.timeout("1 second"))
      yield* Effect.sleep("300 millis")

      expect(yield* remote.claimWake({ sessionID: firstChild.id, generation: "slow-generation" })).toBeUndefined()
      yield* Deferred.succeed(releaseFirstWake, undefined)
      const deadline = Date.now() + 1_000
      while ((yield* recovery.get(firstChild.id))?.wakeClaimedAt === undefined) {
        if (Date.now() >= deadline) yield* Effect.fail(new Error("slow wake did not complete"))
        yield* Effect.sleep("5 millis")
      }
      expect(wakes).toBe(2)
    }),
  )

  background.instance("recovery retains completed task detail without duplicating terminal delivery", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const backgroundChild = yield* sessions.create({ parentID: chat.id, title: "recovered background" })
      const foregroundChild = yield* sessions.create({ parentID: chat.id, title: "retained foreground" })
      const legacyChild = yield* sessions.create({ parentID: chat.id, title: "retained legacy" })
      const nestedChild = yield* sessions.create({ parentID: chat.id, title: "retained nested background" })
      const grandchild = yield* sessions.create({ parentID: nestedChild.id, title: "retained descendant" })
      const recovery = yield* BackgroundTaskExecution.make({ ownerID: "recovery-runtime" })
      const recoveredPart = yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.id,
        sessionID: chat.id,
        type: "tool",
        callID: "recovered-background-task",
        tool: "task",
        state: {
          status: "completed",
          input: { description: backgroundChild.title },
          title: backgroundChild.title,
          metadata: {
            background: true,
            sessionId: backgroundChild.id,
            jobId: backgroundChild.id,
          },
          output: `<task id="${backgroundChild.id}" state="running">`,
          time: { start: Date.now(), end: Date.now() },
        },
      })
      let deletions = 0
      let admissions = 0
      let wakes = 0
      const unsubscribe = yield* events.listen((event) => {
        if (event.type !== Session.Event.Deleted.type) return Effect.void
        return Effect.sync(() => deletions++)
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* recovery.claim({
        sessionID: backgroundChild.id,
        parentSessionID: chat.id,
        generation: "background-generation",
        description: backgroundChild.title,
        parentMessageID: assistant.id,
        wakeRequired: true,
      })
      yield* recovery.settle({
        sessionID: backgroundChild.id,
        generation: "background-generation",
        state: "completed",
        output: "done",
      })

      yield* recovery.claim({
        sessionID: foregroundChild.id,
        parentSessionID: chat.id,
        generation: "foreground-generation",
        description: foregroundChild.title,
        parentMessageID: assistant.id,
        wakeRequired: false,
      })
      yield* recovery.settle({
        sessionID: foregroundChild.id,
        generation: "foreground-generation",
        state: "completed",
        output: "done",
      })
      const foregroundDelivery = yield* recovery.claimDelivery({
        sessionID: foregroundChild.id,
        generation: "foreground-generation",
      })
      if (!foregroundDelivery) throw new Error("foreground terminal delivery was not claimed")
      yield* recovery.completeDelivery({
        sessionID: foregroundChild.id,
        generation: "foreground-generation",
        token: foregroundDelivery.token,
      })

      yield* recovery.claim({
        sessionID: nestedChild.id,
        parentSessionID: chat.id,
        generation: "nested-generation",
        description: nestedChild.title,
        parentMessageID: assistant.id,
        wakeRequired: false,
      })
      yield* recovery.settle({
        sessionID: nestedChild.id,
        generation: "nested-generation",
        state: "completed",
        output: "done",
      })
      const nestedDelivery = yield* recovery.claimDelivery({
        sessionID: nestedChild.id,
        generation: "nested-generation",
      })
      if (!nestedDelivery) throw new Error("nested terminal delivery was not claimed")
      yield* recovery.completeDelivery({
        sessionID: nestedChild.id,
        generation: "nested-generation",
        token: nestedDelivery.token,
      })

      expect(yield* recovery.pendingTerminals()).toHaveLength(1)
      yield* startBackgroundTerminalPump({
        executions: recovery,
        sessions,
        ops: {
          ...stubOps(),
          prompt: (input) => Effect.sync(() => admissions++).pipe(Effect.as(reply(input, "recovered"))),
          wake: () => Effect.sync(() => wakes++),
        },
        interval: "5 millis",
      })

      const deadline = Date.now() + 1_000
      while ((yield* recovery.get(backgroundChild.id))?.wakeClaimedAt === undefined) {
        if (Date.now() >= deadline) yield* Effect.fail(new Error("recovered background wake did not finish"))
        yield* Effect.sleep("5 millis")
      }
      yield* Effect.sleep("30 millis")

      expect((yield* sessions.get(backgroundChild.id)).parentID).toBe(chat.id)
      expect((yield* sessions.get(foregroundChild.id)).parentID).toBe(chat.id)
      expect((yield* sessions.get(legacyChild.id)).parentID).toBe(chat.id)
      expect((yield* sessions.get(nestedChild.id)).parentID).toBe(chat.id)
      expect((yield* sessions.get(grandchild.id)).parentID).toBe(nestedChild.id)
      expect(
        yield* sessions.getPart({
          sessionID: recoveredPart.sessionID,
          messageID: recoveredPart.messageID,
          partID: recoveredPart.id,
        }),
      ).toMatchObject({
        state: {
          metadata: {
            background: true,
            sessionId: backgroundChild.id,
            jobId: backgroundChild.id,
          },
        },
      })
      expect(admissions).toBe(1)
      expect(wakes).toBe(1)
      expect(deletions).toBe(0)
    }),
  )

  background.instance("failed background tasks can restart while parallel tasks keep running", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
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
            return Effect.promise(() => fail.promise).pipe(Effect.flatMap(() => Effect.die(new Error("A exploded"))))
          }
          if (input.parts[0]?.type === "text" && input.parts[0].text === "retry A") {
            return Effect.promise(() => retry.promise).pipe(Effect.as(reply(input, "A recovered")))
          }
          if (input.parts[0]?.type === "text" && input.parts[0].text === "finish B") {
            return Effect.promise(() => finishB.promise).pipe(Effect.as(reply(input, "B done")))
          }
          return Effect.never
        },
        wake: () =>
          Effect.gen(function* () {
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
      expect(failed.parts[0].text).toContain("Report this failure to the user")
      expect(failed.parts[0].text).toContain("Do not relaunch or recreate this background task")
      expect(failed.parts[0].text).toContain("without a new explicit request from the user")
      expect(failed.parts[0].text).not.toContain(`relaunch it with task_id="${a.metadata.sessionId}"`)
      expect(failed.noReply).toBe(true)
      yield* Effect.promise(() => firstWoke.promise).pipe(Effect.timeout("1 second"))
      const failedAcknowledgements = (yield* sessions.messages({ sessionID: chat.id }).pipe(Effect.orDie)).flatMap(
        (message) =>
          message.parts.filter(
            (part) =>
              part.type === "text" && part.synthetic && part.ignored && part.text.startsWith("Background task failed:"),
          ),
      )
      expect(failedAcknowledgements).toEqual([
        expect.objectContaining({
          text: "Background task failed: subagent A. Still running: subagent B, subagent D.",
        }),
      ])
      expect(wakes).toBe(1)
      releaseFirstWake.resolve()
      const wakeDeadline = Date.now() + 1_000
      while ((yield* executions.get(a.metadata.sessionId))?.wakeClaimedAt === undefined) {
        if (Date.now() >= wakeDeadline) yield* Effect.fail(new Error("failed task wake did not complete"))
        yield* Effect.sleep("5 millis")
      }

      const restarted = yield* launch("subagent A", "retry A", a.metadata.sessionId)
      expect(restarted.metadata.sessionId).toBe(a.metadata.sessionId)
      expect((yield* jobs.get(a.metadata.sessionId))?.status).toBe("running")
      expect((yield* jobs.get(b.metadata.sessionId))?.status).toBe("running")
      expect((yield* jobs.get(d.metadata.sessionId))?.status).toBe("running")

      finishB.resolve()
      const completed = yield* Effect.promise(() => secondNotification.promise)
      expect(completed.parts[0]?.type).toBe("text")
      if (completed.parts[0]?.type !== "text") throw new Error("background completion notification text not found")
      expect(completed.parts[0].text).toContain(`<task state="completed">`)
      expect(completed.parts[0].text).not.toContain(`<task id=`)
      expect(completed.parts[0].text).toContain(
        `<active_tasks>${JSON.stringify([
          { task_id: d.metadata.sessionId, description: "subagent D" },
          { task_id: restarted.metadata.sessionId, description: "subagent A" },
        ])}</active_tasks>`,
      )
      expect(completed.noReply).toBe(true)
      yield* Effect.promise(() => secondWoke.promise).pipe(Effect.timeout("1 second"))
      const acknowledgements = (yield* sessions.messages({ sessionID: chat.id }).pipe(Effect.orDie)).flatMap(
        (message) => message.parts.filter((part) => part.type === "text" && part.synthetic && part.ignored),
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

  background.instance(
    "background extension keeps the child model and variant across both dispatches",
    () =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* tool.init()
        const firstSeen = defer<SessionPrompt.PromptInput>()
        const secondSeen = defer<SessionPrompt.PromptInput>()
        const release = defer<void>()
        let childPrompts = 0
        const promptOps: TaskPromptOps = {
          ...stubOps(),
          prompt: (input) => {
            if (input.sessionID === chat.id) return Effect.succeed(reply(input, "notified"))
            childPrompts++
            if (childPrompts === 1) {
              firstSeen.resolve(input)
              return Effect.promise(() => release.promise).pipe(Effect.as(reply(input, "first")))
            }
            secondSeen.resolve(input)
            return Effect.succeed(reply(input, "second"))
          },
        }
        const context = taskContext(chat.id, assistant.id, promptOps)

        const started = yield* def.execute(
          {
            description: "configured child",
            prompt: "first dispatch",
            subagent_type: "general",
            background: true,
          },
          context,
        )
        const first = yield* Effect.promise(() => firstSeen.promise)
        yield* def.execute(
          {
            description: "configured child",
            prompt: "second dispatch",
            subagent_type: "general",
            background: true,
            task_id: started.metadata.sessionId,
          },
          context,
        )

        release.resolve()
        const second = yield* Effect.promise(() => secondSeen.promise).pipe(Effect.timeout("1 second"))
        expect(first.model).toEqual(second.model)
        expect(first.variant).toBe("high")
        expect(second.variant).toBe("high")
        expect((yield* waitForTerminalExecution(started.metadata.sessionId)).state).toBe("completed")
      }),
    { config: { agent: { general: { model: "test/configured", variant: "high" } } } },
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

      const rejected = yield* def
        .execute(
          {
            description: "check progress again",
            prompt: "any update on cancellation",
            subagent_type: "general",
            task_id: started.metadata.sessionId,
          },
          context,
        )
        .pipe(Effect.exit)

      expect(result.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(result.metadata.background).toBe(true)
      expect(typeof started.metadata.backgroundTaskGeneration).toBe("string")
      expect(result.metadata.backgroundTaskGeneration).toBe(started.metadata.backgroundTaskGeneration)
      expect(result.output).toContain("Background task updated")
      expect(Exit.isFailure(rejected)).toBe(true)
      if (Exit.isFailure(rejected)) expect(Cause.pretty(rejected.cause)).toContain("will notify you automatically")
      first.resolve()
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      expect((yield* Effect.promise(() => updated.promise)).parts).toEqual([
        { type: "text", text: "also inspect cancellation" },
      ])

      second.resolve()
      const terminal = yield* waitForTerminalExecution(started.metadata.sessionId)
      expect(terminal.state).toBe("completed")
      expect(terminal.output).toBe("second done")
      const notification = yield* Effect.promise(() => injected.promise)
      expect(notification.variant).toBe("xhigh")
      expect(notification.parts[0]?.type).toBe("text")
      if (notification.parts[0]?.type === "text") expect(notification.parts[0].text).toContain("second done")
    }),
  )

  background.instance("background tasks persist results before evicting the terminal job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const executions = yield* BackgroundTaskExecution.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const delivered = defer<void>()

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
                input.sessionID === chat.id
                  ? Effect.sync(() => delivered.resolve()).pipe(Effect.as(reply(input, "notified")))
                  : Effect.succeed(reply(input, "background done")),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* Effect.promise(() => delivered.promise)
      expect(yield* executions.get(result.metadata.sessionId)).toMatchObject({
        state: "completed",
        output: "background done",
      })
      expect(yield* jobs.get(result.metadata.sessionId)).toBeUndefined()
    }),
  )

  background.instance("background task completion does not wait for the parent async prompt", () =>
    Effect.gen(function* () {
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

      expect((yield* waitForTerminalExecution(result.metadata.sessionId)).state).toBe("completed")
    }),
  )

  background.instance("removing the parent session cancels and evicts running background tasks", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
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
      yield* waitForJobEviction(result.metadata.sessionId)
      expect(yield* executions.get(result.metadata.sessionId)).toBeUndefined()
    }),
  )

  background.instance("removing the child task session cancels and evicts its running background task", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
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
      yield* waitForJobEviction(result.metadata.sessionId)
      expect(yield* executions.get(result.metadata.sessionId)).toBeUndefined()
    }),
  )

  background.instance("cancelling the parent run cancels running background tasks", () =>
    Effect.gen(function* () {
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const terminal = yield* Deferred.make<SessionPrompt.PromptInput>()
      let wakes = 0

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
              prompt: (input) =>
                input.sessionID === chat.id
                  ? Deferred.succeed(terminal, input).pipe(Effect.as(reply(input, "cancelled")))
                  : Effect.never,
              wake: () =>
                Effect.sync(() => {
                  wakes++
                }),
            } satisfies TaskPromptOps,
          },
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* runState.cancel(chat.id)
      expect((yield* waitForTerminalExecution(result.metadata.sessionId)).state).toBe("cancelled")
      const admitted = yield* Deferred.await(terminal).pipe(Effect.timeout("1 second"))
      expect(admitted.parts[0]).toEqual(
        expect.objectContaining({
          type: "text",
          synthetic: true,
          metadata: expect.objectContaining({
            backgroundTaskID: result.metadata.sessionId,
            backgroundTaskState: "cancelled",
          }),
        }),
      )
      expect(wakes).toBe(0)
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
      const runState = yield* SessionRunState.Service
      const { chat, assistant } = yield* seed()
      const task = yield* TaskTool
      const taskDef = yield* task.init()
      const stop = yield* TaskStopTool
      const stopDef = yield* stop.init()
      const terminal = yield* Deferred.make<SessionPrompt.PromptInput>()
      let childPrompts = 0
      let wakes = 0
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        cancel: (sessionID) => runState.cancel(sessionID),
        prompt: (input) => {
          if (input.sessionID === chat.id) {
            return Deferred.succeed(terminal, input).pipe(Effect.as(reply(input, "acknowledged")))
          }
          childPrompts++
          if (childPrompts === 1) return Effect.never
          return Effect.succeed(reply(input, "restarted"))
        },
        wake: () =>
          Effect.sync(() => {
            wakes++
          }),
      }
      const context = taskContext(chat.id, assistant.id, promptOps)
      const started = yield* taskDef.execute(
        { description: "subagent A", prompt: "run A", subagent_type: "general", background: true },
        context,
      )

      yield* stopDef.execute({ task_ids: [started.metadata.sessionId] }, context)
      expect((yield* waitForTerminalExecution(started.metadata.sessionId)).state).toBe("cancelled")
      const cancelled = yield* Deferred.await(terminal).pipe(Effect.timeout("1 second"))
      expect(cancelled.parts[0]).toEqual(
        expect.objectContaining({
          type: "text",
          synthetic: true,
          metadata: expect.objectContaining({
            backgroundTaskID: started.metadata.sessionId,
            backgroundTaskState: "cancelled",
            backgroundTaskGeneration: started.metadata.backgroundTaskGeneration,
          }),
        }),
      )
      expect(typeof started.metadata.backgroundTaskGeneration).toBe("string")
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
      const terminalExecution = yield* waitForTerminalExecution(restarted.metadata.sessionId)

      expect(restarted.metadata.sessionId).toBe(started.metadata.sessionId)
      expect(typeof restarted.metadata.backgroundTaskGeneration).toBe("string")
      expect(restarted.metadata.backgroundTaskGeneration).not.toBe(started.metadata.backgroundTaskGeneration)
      expect(terminalExecution.state).toBe("completed")
      expect(terminalExecution.output).toBe("restarted")
      expect(wakes).toBe(1)
    }),
  )

  background.instance("waits for cancelled terminal delivery before relaunch", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
      const jobs = yield* BackgroundJob.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const terminal = defer<SessionPrompt.PromptInput>()
      const releaseTerminal = defer<void>()
      const promptOps: TaskPromptOps = {
        ...stubOps(),
        prompt: (input) => {
          if (input.sessionID !== chat.id) return Effect.never
          terminal.resolve(input)
          return Effect.promise(() => releaseTerminal.promise).pipe(Effect.as(reply(input, "acknowledged")))
        },
      }
      const started = yield* def.execute(
        { description: "subagent A", prompt: "run A", subagent_type: "general", background: true },
        { ...taskContext(chat.id, assistant.id, promptOps), callID: "call-1" },
      )

      yield* jobs.cancel(started.metadata.sessionId)
      const lateTerminal = yield* Effect.promise(() => terminal.promise).pipe(Effect.timeout("1 second"))
      const retry = {
        description: "subagent A",
        prompt: "retry A",
        subagent_type: "general",
        background: true,
        task_id: started.metadata.sessionId,
      } as const
      const context = { ...taskContext(chat.id, assistant.id, promptOps), callID: "call-2" }
      const waiting = yield* def.execute(retry, context)
      expect(waiting.metadata.background).toBe(true)
      expect(waiting.output).toContain("Another OpenCode process is delivering this task result")
      expect(waiting.output).toContain("do not relaunch it")

      releaseTerminal.resolve()
      const deadline = Date.now() + 1_000
      while ((yield* executions.get(started.metadata.sessionId))?.terminalDeliveredAt === undefined) {
        if (Date.now() >= deadline) yield* Effect.fail(new Error("cancelled terminal was not delivered"))
        yield* Effect.sleep("5 millis")
      }
      const restarted = yield* def.execute(
        {
          ...retry,
        },
        context,
      )

      expect(started.metadata.backgroundTaskGeneration).toBe(`${assistant.id}:call-1`)
      expect(restarted.metadata.backgroundTaskGeneration).toBe(`${assistant.id}:call-2`)
      expect(lateTerminal.parts[0]).toEqual(
        expect.objectContaining({
          type: "text",
          metadata: expect.objectContaining({
            backgroundTaskID: started.metadata.sessionId,
            backgroundTaskGeneration: started.metadata.backgroundTaskGeneration,
          }),
        }),
      )
      expect((yield* jobs.get(started.metadata.sessionId))?.metadata?.backgroundTaskGeneration).toBe(
        restarted.metadata.backgroundTaskGeneration,
      )
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")

      yield* Effect.yieldNow
      expect((yield* jobs.get(started.metadata.sessionId))?.status).toBe("running")
      yield* jobs.cancel(started.metadata.sessionId)
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

  background.instance("cancelling a parent durably requests cancellation from a remote descendant owner", () =>
    Effect.gen(function* () {
      const runState = yield* SessionRunState.Service
      const sessions = yield* Session.Service
      const { chat } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "remote child" })
      const remote = yield* BackgroundTaskExecution.make({ ownerID: "remote-runtime" })
      yield* remote.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "remote-generation",
        description: child.title,
        parentMessageID: MessageID.ascending(),
      })

      yield* runState.cancel(chat.id)

      expect(yield* remote.heartbeat({ sessionID: child.id, generation: "remote-generation" })).toBe("cancelled")
    }),
  )

  background.instance("projects a remotely owned task as busy until cancellation is requested", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "remote child" })
      const remote = yield* BackgroundTaskExecution.make({ ownerID: "remote-runtime" })
      yield* remote.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "remote-generation",
        description: child.title,
        parentMessageID: assistant.id,
      })

      expect(yield* status.get(child.id)).toEqual({ type: "busy" })
      expect((yield* status.list()).get(child.id)).toEqual({ type: "busy" })

      yield* remote.requestCancel(child.id)

      expect(yield* status.get(child.id)).toEqual({ type: "idle" })
      expect((yield* status.list()).has(child.id)).toBe(false)
    }),
  )

  background.instance("task_stop persists cancellation for a remotely owned task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "remote child" })
      const remote = yield* BackgroundTaskExecution.make({ ownerID: "remote-runtime" })
      yield* remote.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "remote-generation",
        description: child.title,
        parentMessageID: assistant.id,
      })
      const stop = yield* TaskStopTool
      const def = yield* stop.init()

      const result = yield* def.execute({ task_ids: [child.id] }, taskContext(chat.id, assistant.id, stubOps()))

      expect(result.metadata.statuses).toEqual([{ task_id: child.id, status: "cancelled" }])
      expect(yield* remote.heartbeat({ sessionID: child.id, generation: "remote-generation" })).toBe("cancelled")
    }),
  )

  background.instance("waits when another runtime owns the prior terminal delivery", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "remote child" })
      const remote = yield* BackgroundTaskExecution.make({ ownerID: "remote-runtime" })
      yield* remote.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "remote-generation",
        description: child.title,
        parentMessageID: assistant.id,
      })
      yield* remote.settle({
        sessionID: child.id,
        generation: "remote-generation",
        state: "error",
        error: "remote failure",
      })
      expect(yield* remote.claimDelivery({ sessionID: child.id, generation: "remote-generation" })).toBeDefined()

      const tool = yield* TaskTool
      const def = yield* tool.init()
      const exit = yield* def
        .execute(
          {
            description: "retry remote child",
            prompt: "retry",
            subagent_type: "general",
            background: true,
            task_id: child.id,
          },
          { ...taskContext(chat.id, assistant.id, stubOps()), callID: "retry-call" },
        )
        .pipe(Effect.exit)

      expect(Exit.isSuccess(exit)).toBe(true)
      if (Exit.isSuccess(exit)) {
        expect(exit.value.metadata.background).toBe(true)
        expect(exit.value.output).toContain("Another OpenCode process is delivering this task result")
        expect(exit.value.output).toContain("do not relaunch it")
      }
      expect((yield* remote.get(child.id))?.generation).toBe("remote-generation")
      expect(yield* jobs.get(child.id)).toBeUndefined()
    }),
  )

  background.instance("restarts from the assistant consuming a terminal while its wake is active", () =>
    Effect.gen(function* () {
      const executions = yield* BackgroundTaskExecution.Service
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const child = yield* sessions.create({ parentID: chat.id, title: "causal retry" })
      yield* executions.claim({
        sessionID: child.id,
        parentSessionID: chat.id,
        generation: "old-generation",
        description: child.title,
        parentMessageID: assistant.id,
        wakeRequired: true,
      })
      const terminal = yield* executions.settle({
        sessionID: child.id,
        generation: "old-generation",
        state: "completed",
        output: "incomplete",
      })
      if (!terminal) throw new Error("terminal execution missing")
      const delivery = yield* executions.claimDelivery({ sessionID: child.id, generation: terminal.generation })
      if (!delivery) throw new Error("terminal delivery was not claimed")
      yield* executions.completeDelivery({
        sessionID: child.id,
        generation: terminal.generation,
        token: delivery.token,
      })
      const wake = yield* executions.claimWake({ sessionID: child.id, generation: terminal.generation })
      if (!wake) throw new Error("terminal wake was not claimed")
      const causal = yield* sessions.updateMessage({
        ...assistant,
        id: MessageID.ascending(),
        parentID: terminal.delivery.messageID,
        time: { created: Date.now() },
      })
      const tool = yield* TaskTool
      const def = yield* tool.init()
      const result = yield* def.execute(
        {
          description: "complete causal retry",
          prompt: "finish the result",
          subagent_type: "general",
          background: true,
          task_id: child.id,
        },
        {
          ...taskContext(chat.id, causal.id, {
            ...stubOps(),
            prompt: (input) => (input.sessionID === child.id ? Effect.never : Effect.succeed(reply(input, "notified"))),
          }),
          callID: "causal-retry",
        },
      )

      expect(result.output).toContain("Background task started")
      expect(result.metadata.backgroundTaskGeneration).toBe(`${causal.id}:causal-retry`)
      expect(yield* executions.get(child.id)).toMatchObject({
        generation: `${causal.id}:causal-retry`,
        state: "running",
      })
      expect(
        yield* executions.completeWake({
          sessionID: child.id,
          generation: terminal.generation,
          token: wake.token,
        }),
      ).toBe(false)
      yield* jobs.cancel(child.id)
    }),
  )
})
