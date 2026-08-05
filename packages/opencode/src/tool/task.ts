import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Provider } from "@/provider/provider"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
  wake(sessionID: SessionID): Effect.Effect<void>
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "Background mode: Omitting background launches the subagent asynchronously and returns immediately.",
  "Set background=false only when you need the result before continuing.",
  "Use background execution for independent parallel subagents when you must react to each completion or error while the others keep running.",
  "React to each notification immediately; retry a recoverable failure with the same task_id, and do not poll active tasks.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Optional model override in the format of provider/model. Omit unless the user explicitly asks for a specific model.",
  }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run the agent in the background (default: true). Set false to wait synchronously. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

const TaskStopParameters = Schema.Struct({
  task_ids: Schema.NonEmptyArray(Schema.String).annotate({
    description: "One or more background task IDs owned by the current primary session",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error" | "cancelled"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${escapeXmlAttribute(input.sessionID)}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${escapeXmlText(input.summary)}</summary>`] : []),
    `<${tag}>`,
    escapeXmlText(input.text),
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

function escapeXmlText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeXmlAttribute(value: string) {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

function renderActiveTasks(tasks: { task_id: SessionID; description: string }[]) {
  return `<active_tasks>${escapeXmlText(JSON.stringify(tasks))}</active_tasks>`
}

type TaskModel = ReturnType<typeof Provider.parseModel> & { variant?: string }

function normalizeVariant(variant: string | undefined) {
  return variant === "default" ? undefined : variant
}

function sameModel(a: TaskModel, b: TaskModel | undefined) {
  return (
    b !== undefined &&
    a.providerID === b.providerID &&
    a.modelID === b.modelID &&
    normalizeVariant(a.variant) === normalizeVariant(b.variant)
  )
}

function formatModel(model: TaskModel) {
  return `${model.providerID}/${model.modelID}`
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    const reactions = KeyedMutex.makeUnsafe<SessionID>()
    const dispatches = KeyedMutex.makeUnsafe<SessionID>()

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      const runInBackground = params.background ?? flags.experimentalBackgroundSubagents
      if (params.model !== undefined && !/^[^/\s]+\/(?:[^/\s]+\/)*[^/\s]+$/.test(params.model)) {
        return yield* Effect.fail(new Error(`Invalid model: ${params.model}. Expected provider/model.`))
      }
      const explicitModel: TaskModel | undefined =
        params.model !== undefined ? { ...Provider.parseModel(params.model), variant: "default" } : undefined
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      const ancestry = new Set<SessionID>()
      let current = parent
      let depth = 0
      while (true) {
        if (ancestry.has(current.id)) {
          return yield* Effect.fail(new Error("Session ancestry cycle detected"))
        }
        ancestry.add(current.id)
        if (!current.parentID) break
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const session = params.task_id
        ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      if (session && session.parentID !== ctx.sessionID) {
        return yield* Effect.fail(new Error("Task not found"))
      }

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      const parentMessage = msg.info
      if (parentMessage.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const parentModel: TaskModel = {
        modelID: parentMessage.modelID,
        providerID: parentMessage.providerID,
        variant: parentMessage.variant,
      }
      const agentModel: TaskModel | undefined = next.model ? { ...next.model, variant: next.variant } : undefined
      const storedModel: TaskModel | undefined = session?.model
        ? {
            modelID: session.model.id,
            providerID: session.model.providerID,
            variant: session.model.variant ?? "default",
          }
        : undefined
      const trustedModel = agentModel ?? parentModel
      const model = explicitModel ?? storedModel ?? trustedModel
      const needsModelPermission = !sameModel(model, trustedModel)

      if (needsModelPermission) {
        const pattern = formatModel(model)
        yield* ctx.ask({
          permission: "model_override",
          patterns: [pattern],
          always: [pattern],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
            model: pattern,
          },
        })
      }
      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          model: {
            providerID: model.providerID,
            id: model.modelID,
            ...(model.variant !== undefined ? { variant: model.variant } : {}),
          },
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        backgroundTaskGeneration: undefined as string | undefined,
        ...(runInBackground ? { background: true } : {}),
      }
      const requestedGeneration = ctx.callID
        ? `${ctx.messageID}:${ctx.callID}`
        : `${ctx.messageID}:${PartID.ascending()}`

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          variant: model.variant,
          agent: next.name,
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const admit = Effect.fn("TaskTool.admitBackgroundResult")(function* (
        state: "completed" | "error" | "cancelled",
        text: string,
        generation: string | undefined,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const parentAgent = currentParent.agent ?? ctx.agent
        const activeTasks = (yield* background.list())
          .filter(
            (job) =>
              job.status === "running" &&
              job.type === id &&
              job.metadata?.background === true &&
              job.metadata?.parentSessionId === ctx.sessionID &&
              typeof job.metadata.sessionId === "string",
          )
          .flatMap((job) => {
            const sessionID = job.metadata?.sessionId
            if (typeof sessionID !== "string") return []
            return [{ task_id: SessionID.make(sessionID), description: job.title ?? job.id }]
          })
        const event = yield* ops.prompt({
          sessionID: ctx.sessionID,
          agent: parentAgent,
          variant: parentMessage.variant,
          noReply: true,
          parts: [
            {
              type: "text",
              synthetic: true,
              metadata: {
                backgroundTaskID: nextSession.id,
                backgroundTaskState: state,
                ...(generation !== undefined ? { backgroundTaskGeneration: generation } : {}),
              },
              text: [
                renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : state === "error"
                        ? `Background task failed: ${params.description}`
                        : `Background task cancelled: ${params.description}`,
                  text,
                }),
                renderActiveTasks(activeTasks),
                state === "cancelled"
                  ? "This task was cancelled intentionally. Do not relaunch it unless the user asks."
                  : `React to this event now. If it failed and retry is appropriate, relaunch it with task_id="${nextSession.id}". Do not poll the active tasks.`,
              ].join("\n"),
            },
          ],
        })
        return { activeTasks, event, parentAgent }
      })

      const acknowledge = Effect.fn("TaskTool.acknowledgeBackgroundResult")(function* (
        admitted: {
          activeTasks: { task_id: SessionID; description: string }[]
          event: SessionV1.WithParts
          parentAgent: string
        },
        state: "completed" | "error" | "cancelled",
      ) {
        const time = Date.now()
        const acknowledgement = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: admitted.event.info.id,
          sessionID: ctx.sessionID,
          mode: admitted.parentAgent,
          agent: admitted.parentAgent,
          variant: parentMessage.variant,
          path: parentMessage.path,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: parentMessage.modelID,
          providerID: parentMessage.providerID,
          time: { created: time, completed: time },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: acknowledgement.id,
          sessionID: ctx.sessionID,
          type: "text",
          synthetic: true,
          ignored: true,
          text: [
            `Background task ${state === "completed" ? "completed" : state === "error" ? "failed" : "cancelled"}: ${params.description}.`,
            admitted.activeTasks.length > 0
              ? `Still running: ${admitted.activeTasks.map((task) => task.description).join(", ")}.`
              : "No background tasks remain.",
          ].join(" "),
        })
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (
        jobID: string,
        generation: string | undefined,
      ) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            const terminal =
              result.info?.status === "completed"
                ? (["completed", result.info.output ?? ""] as const)
                : result.info?.status === "error"
                  ? (["error", result.info.error ?? ""] as const)
                  : result.info?.status === "cancelled"
                    ? (["cancelled", "Task cancelled."] as const)
                    : undefined
            if (!terminal) return Effect.void
            return reactions.withLock(ctx.sessionID)(
              Effect.gen(function* () {
                const admitted = yield* admit(terminal[0], terminal[1], generation)
                const wake = terminal[0] === "cancelled" ? Effect.void : ops.wake(ctx.sessionID)
                yield* acknowledge(admitted, terminal[0]).pipe(Effect.ensuring(wake))
              }),
            )
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const dispatch = yield* dispatches.withLock(nextSession.id)(
        Effect.gen(function* () {
          if (yield* background.extend({ id: nextSession.id, run: runTask() })) {
            const current = yield* background.get(nextSession.id)
            const generation =
              typeof current?.metadata?.backgroundTaskGeneration === "string"
                ? current.metadata.backgroundTaskGeneration
                : undefined
            const nextMetadata = {
              ...metadata,
              ...(generation !== undefined ? { backgroundTaskGeneration: generation } : {}),
            }
            yield* ctx.metadata({
              title: params.description,
              metadata: { ...nextMetadata, background: true, jobId: nextSession.id },
            })
            return { extended: true as const, generation, metadata: nextMetadata }
          }

          const nextMetadata = { ...metadata, backgroundTaskGeneration: requestedGeneration }
          const info = yield* background.start({
            id: nextSession.id,
            type: id,
            title: params.description,
            metadata: nextMetadata,
            onPromote: Effect.all([
              ctx.metadata({
                title: params.description,
                metadata: { ...nextMetadata, background: true, jobId: nextSession.id },
              }),
              notify(nextSession.id, requestedGeneration),
            ]),
            run: runTask().pipe(
              Effect.onExit((exit) => (Exit.isFailure(exit) ? ops.cancel(nextSession.id) : Effect.void)),
            ),
          })
          yield* ctx.metadata({ title: params.description, metadata: nextMetadata })
          return { extended: false as const, generation: requestedGeneration, metadata: nextMetadata, info }
        }),
      )

      if (dispatch.extended) {
        return {
          title: params.description,
          metadata: {
            ...dispatch.metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = dispatch.info

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...dispatch.metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id, dispatch.generation)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            const result = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
              background.waitForPromotion(nextSession.id),
            )
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents
        ? [DESCRIPTION, BACKGROUND_DESCRIPTION].join("\n\n")
        : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

export const TaskStopTool = Tool.define(
  "task_stop",
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const flags = yield* RuntimeFlags.Service

    return {
      description: "Stop one or more running background subagents owned by the current primary session.",
      parameters: TaskStopParameters,
      execute: (params: Schema.Schema.Type<typeof TaskStopParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const parent = yield* sessions.get(ctx.sessionID)
          if (!flags.experimentalBackgroundSubagents || parent.parentID) {
            return yield* Effect.fail(new Error("Unable to stop one or more tasks"))
          }

          const ops = ctx.extra?.promptOps as TaskPromptOps
          if (!ops) return yield* Effect.fail(new Error("TaskStopTool requires promptOps in ctx.extra"))

          const taskIDs = [...new Set(params.task_ids.map((taskID) => SessionID.make(taskID)))]
          const targets = yield* Effect.forEach(
            taskIDs,
            Effect.fnUntraced(function* (taskID) {
              const session = yield* sessions.get(taskID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
              const job = yield* background.get(taskID)
              const valid =
                session?.parentID === ctx.sessionID &&
                job?.type === id &&
                job.metadata?.parentSessionId === ctx.sessionID &&
                job.metadata?.sessionId === taskID &&
                job.metadata?.background === true
              if (!valid) return { valid: false as const }
              return { valid: true as const, taskID, job }
            }),
          )
          if (targets.some((target) => !target.valid)) {
            return yield* Effect.fail(new Error("Unable to stop one or more tasks"))
          }

          const statuses = yield* Effect.forEach(
            targets.flatMap((target) => (target.valid ? [target] : [])),
            Effect.fnUntraced(function* (target) {
              if (target.job.status === "running") yield* ops.cancel(target.taskID)
              return {
                task_id: target.taskID,
                status: (yield* background.get(target.taskID))?.status ?? target.job.status,
              }
            }),
            { concurrency: "unbounded" },
          )
          const active_tasks = (yield* background.list())
            .filter(
              (job) =>
                job.type === id &&
                job.status === "running" &&
                job.metadata?.background === true &&
                job.metadata?.parentSessionId === ctx.sessionID &&
                job.metadata?.sessionId === job.id,
            )
            .map((job) => ({ task_id: SessionID.make(job.id), description: job.title ?? job.id }))

          return {
            title: "Stopped background tasks",
            metadata: { statuses, active_tasks },
            output: [
              `<task_statuses>${escapeXmlText(JSON.stringify(statuses))}</task_statuses>`,
              renderActiveTasks(active_tasks),
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
