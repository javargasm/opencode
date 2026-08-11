import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { BackgroundTaskExecution } from "@/background/task-execution"
import { Session } from "@/session/session"
import { SessionID, MessageID, PartID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Provider } from "@/provider/provider"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Cause, Duration, Effect, Exit, Option, Schedule, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  interrupt(sessionID: SessionID): Effect.Effect<void>
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
  variant: Schema.optional(Schema.String).annotate({
    description: "Optional provider-specific model variant, such as a reasoning effort (for example, high or max).",
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
    `<task${input.state === "completed" ? "" : ` id="${escapeXmlAttribute(input.sessionID)}"`} state="${input.state}">`,
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

export const deliverBackgroundTerminal = Effect.fn("TaskTool.deliverBackgroundTerminal")(function* (input: {
  executions: BackgroundTaskExecution.Interface
  sessions: Session.Interface
  ops: TaskPromptOps
  terminal: BackgroundTaskExecution.Info
  variant?: string
  afterAdmit?: (input: {
    activeTasks: { task_id: SessionID; description: string }[]
    event: SessionV1.WithParts
    parentAgent: string
  }) => Effect.Effect<void>
}) {
  const current = yield* input.executions.get(input.terminal.sessionID)
  if (!current || current.generation !== input.terminal.generation || current.state === "running") return false
  const delivery =
    current.terminalDeliveredAt === undefined
      ? yield* input.executions.claimDelivery({ sessionID: current.sessionID, generation: current.generation })
      : undefined
  if (current.terminalDeliveredAt === undefined && !delivery) return false
  const terminal = current

  if (delivery) {
    const existing = yield* input.sessions.getPart({
      sessionID: terminal.parentSessionID,
      messageID: terminal.delivery.messageID,
      partID: terminal.delivery.partID,
    })
    if (!existing) {
      const parent = yield* input.sessions.get(terminal.parentSessionID)
      const parentAgent = parent.agent ?? "build"
      const activeTasks = (yield* input.executions.listRunning(terminal.parentSessionID))
        .filter((task) => task.cancelRequestedAt === undefined)
        .map((task) => ({ task_id: task.sessionID, description: task.description }))
      const parentMessage = terminal.parentVariant
        ? undefined
        : yield* input.sessions
            .getMessage({
              sessionID: terminal.parentSessionID,
              messageID: terminal.parentMessageID,
            })
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const event = yield* input.ops.prompt({
        sessionID: terminal.parentSessionID,
        messageID: terminal.delivery.messageID,
        agent: parentAgent,
        variant:
          terminal.parentVariant ??
          (parentMessage?.info.role === "assistant" ? parentMessage.info.variant : undefined) ??
          input.variant,
        noReply: true,
        parts: [
          {
            id: terminal.delivery.partID,
            type: "text",
            synthetic: true,
            metadata: {
              backgroundTaskID: terminal.sessionID,
              backgroundTaskState: terminal.state,
              backgroundTaskGeneration: terminal.generation,
            },
            text: [
              renderOutput({
                sessionID: terminal.sessionID,
                state: terminal.state,
                summary:
                  terminal.state === "completed"
                    ? `Background task completed: ${terminal.description}`
                    : terminal.state === "error"
                      ? `Background task failed: ${terminal.description}`
                      : `Background task cancelled: ${terminal.description}`,
                text:
                  terminal.state === "completed"
                    ? (terminal.output ?? "")
                    : terminal.state === "error"
                      ? (terminal.error ?? "Task failed.")
                      : "Task cancelled.",
              }),
              renderActiveTasks(activeTasks),
              terminal.state === "cancelled"
                ? "This task was cancelled intentionally. Do not relaunch it unless the user asks."
                : terminal.state === "error"
                  ? `React to this event now. If retry is appropriate, relaunch it with task_id="${terminal.sessionID}". Do not poll the active tasks.`
                  : "React to this event now. Do not poll the active tasks.",
            ].join("\n"),
          },
        ],
      })
      if (input.afterAdmit) yield* input.afterAdmit({ activeTasks, event, parentAgent })
    }
    if (
      !(yield* input.executions.completeDelivery({
        sessionID: terminal.sessionID,
        generation: terminal.generation,
        token: delivery.token,
      }))
    ) {
      return false
    }
  }

  if (terminal.state === "cancelled" || !terminal.wakeRequired) return true
  const wake = yield* input.executions.claimWake({ sessionID: terminal.sessionID, generation: terminal.generation })
  if (!wake) return true
  const watch = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(Math.max(10, Math.floor(input.executions.leaseMillis / 3))))
      if (
        (yield* input.executions.heartbeatWake({
          sessionID: terminal.sessionID,
          generation: terminal.generation,
          token: wake.token,
        })) !== "owned"
      ) {
        return yield* Effect.interrupt
      }
    }
  })
  yield* Effect.raceFirst(input.ops.wake(terminal.parentSessionID), watch)
  return yield* input.executions.completeWake({
    sessionID: terminal.sessionID,
    generation: terminal.generation,
    token: wake.token,
  })
})

export const recoverBackgroundTerminals = Effect.fn("TaskTool.recoverBackgroundTerminals")(function* (input: {
  executions: BackgroundTaskExecution.Interface
  sessions: Session.Interface
  ops: TaskPromptOps
  sessionID?: SessionID
  provide?: (
    terminal: BackgroundTaskExecution.Info,
    delivery: Effect.Effect<boolean, unknown>,
  ) => Effect.Effect<boolean, unknown>
}) {
  yield* Effect.forEach(
    yield* input.executions.pendingTerminals(input.sessionID),
    (terminal) =>
      (input.provide
        ? input.provide(terminal, deliverBackgroundTerminal({ ...input, terminal }))
        : deliverBackgroundTerminal({ ...input, terminal })
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to recover background task terminal", { sessionID: terminal.sessionID, cause }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  )
})

export const startBackgroundTerminalPump = Effect.fn("TaskTool.startBackgroundTerminalPump")(function* (input: {
  executions: BackgroundTaskExecution.Interface
  sessions: Session.Interface
  ops: TaskPromptOps
  interval?: Duration.Input
  provide?: (
    terminal: BackgroundTaskExecution.Info,
    delivery: Effect.Effect<boolean, unknown>,
  ) => Effect.Effect<boolean, unknown>
}) {
  const inFlight = new Set<SessionID>()
  const terminals = input.executions.pendingTerminals().pipe(
    Effect.flatMap((terminals) =>
      Effect.forEach(
        terminals,
        (terminal) => {
          const leaseExpiresAt = terminal.terminalDeliveredAt
            ? terminal.wakeLeaseExpiresAt
            : terminal.deliveryLeaseExpiresAt
          if (inFlight.has(terminal.sessionID) && leaseExpiresAt === undefined) return Effect.void
          inFlight.add(terminal.sessionID)
          return (
            input.provide
              ? input.provide(terminal, deliverBackgroundTerminal({ ...input, terminal }))
              : deliverBackgroundTerminal({ ...input, terminal })
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to recover background task terminal", { sessionID: terminal.sessionID, cause }),
            ),
            Effect.ensuring(Effect.sync(() => inFlight.delete(terminal.sessionID))),
            Effect.forkScoped,
          )
        },
        { concurrency: "unbounded", discard: true },
      ),
    ),
    Effect.catchCause((cause) => Effect.logWarning("background terminal recovery failed", { cause })),
  )
  return yield* terminals.pipe(
    Effect.repeat(Schedule.spaced(input.interval ?? "1 second")),
    Effect.forkScoped({ startImmediately: true }),
  )
})

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
    const executions = yield* BackgroundTaskExecution.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
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
        params.model !== undefined
          ? { ...Provider.parseModel(params.model), variant: params.variant ?? "default" }
          : undefined
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
      const selectedModel = explicitModel ?? storedModel ?? trustedModel
      const model: TaskModel =
        explicitModel || params.variant === undefined ? selectedModel : { ...selectedModel, variant: params.variant }

      if (params.variant !== undefined && normalizeVariant(params.variant) !== undefined) {
        const resolved = yield* provider
          .getModel(model.providerID, model.modelID)
          .pipe(Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined)))
        if (resolved?.variants && !(params.variant in resolved.variants)) {
          return yield* Effect.fail(
            new Error(`Invalid variant: ${params.variant}. ${formatModel(model)} does not provide that variant.`),
          )
        }
      }
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
            ...(params.variant !== undefined ? { variant: model.variant } : {}),
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
          title: `(subagente) ${parent.title}`,
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
          ...(params.variant !== undefined ? { variant: model.variant } : {}),
        },
        backgroundTaskGeneration: undefined as string | undefined,
        ...(runInBackground ? { background: true } : {}),
      }
      const requestedGeneration = ctx.callID
        ? `${ctx.messageID}:${ctx.callID}`
        : `${ctx.messageID}:${PartID.ascending()}`
      const observedDeliveryMessageID = parentMessage.parentID

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
        const initial = result.parts.findLast((item) => item.type === "text")?.text ?? ""
        while ((yield* executions.listPendingHandoffs(nextSession.id)).length > 0) {
          yield* Effect.sleep("250 millis")
        }
        const latest = Option.getOrUndefined(
          yield* sessions
            .findMessage(
              nextSession.id,
              (message) =>
                message.info.role === "assistant" &&
                message.parts.some((part) => part.type === "text" && !part.ignored),
            )
            .pipe(Effect.orDie),
        )
        const latestText = latest?.parts.findLast(
          (item): item is Extract<(typeof latest.parts)[number], { type: "text" }> =>
            item.type === "text" && !item.ignored,
        )
        return latestText?.text ?? initial
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

      const settleResult = Effect.fn("TaskTool.settleBackgroundResult")(function* (
        result: BackgroundJob.Info | undefined,
        generation: string,
      ) {
        if (result?.status === "completed") {
          yield* executions.settle({
            sessionID: nextSession.id,
            generation,
            state: "completed",
            output: result.output ?? "",
          })
        }
        if (result?.status === "error") {
          yield* executions.settle({
            sessionID: nextSession.id,
            generation,
            state: "error",
            error: result.error ?? "Task failed",
          })
        }
        if (result?.status === "cancelled") {
          yield* executions.settle({
            sessionID: nextSession.id,
            generation,
            state: "cancelled",
            error: "Task cancelled",
          })
        }
        return yield* executions.get(nextSession.id)
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (
        jobID: string,
        generation: string | undefined,
      ) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (generation === undefined) return
              const terminal = yield* settleResult(result.info, generation)
              if (!terminal || terminal.generation !== generation || terminal.state === "running") return
              yield* background.evict(jobID)
              const terminalState = terminal.state
              yield* deliverBackgroundTerminal({
                executions,
                sessions,
                ops,
                terminal,
                variant: parentMessage.variant,
                afterAdmit: (admitted) => acknowledge(admitted, terminalState),
              })
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      const ownedRun = Effect.fn("TaskTool.ownedRun")(function* (generation: string) {
        const current = yield* executions.heartbeat({ sessionID: nextSession.id, generation })
        if (current !== "owned") return yield* Effect.interrupt
        const watch = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("250 millis")
            if ((yield* executions.heartbeat({ sessionID: nextSession.id, generation })) !== "owned") {
              return yield* Effect.interrupt
            }
          }
        })
        return yield* Effect.raceFirst(
          runTask().pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                ? background
                    .get(nextSession.id)
                    .pipe(
                      Effect.flatMap((job) =>
                        job?.metadata?.background === true ? ops.interrupt(nextSession.id) : ops.cancel(nextSession.id),
                      ),
                    )
                : Effect.void,
            ),
          ),
          watch,
        )
      })

      const dispatch = yield* dispatches.withLock(nextSession.id)(
        Effect.gen(function* () {
          if (session !== undefined) {
            const resumed = yield* sessions.get(nextSession.id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            if (!resumed || resumed.parentID !== ctx.sessionID) {
              return yield* Effect.fail(new Error("Task not found"))
            }
          }
          const current = yield* background.get(nextSession.id)
          if (current?.status === "running") {
            const generation =
              typeof current?.metadata?.backgroundTaskGeneration === "string"
                ? current.metadata.backgroundTaskGeneration
                : undefined
            const followup =
              current.metadata?.background === true && generation !== undefined
                ? yield* executions.claimFollowup({ sessionID: nextSession.id, generation })
                : undefined
            if (followup === "already_claimed") {
              return yield* Effect.fail(
                new Error(
                  "This background task is still running and already received its follow-up. It will notify you automatically when it finishes.",
                ),
              )
            }
            if (followup === "inactive") {
              yield* background.cancel(nextSession.id)
            } else {
              if (!generation || !(yield* background.extend({ id: nextSession.id, run: ownedRun(generation) }))) {
                return yield* Effect.fail(new Error("Unable to continue background task"))
              }
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
          }

          const nextMetadata = { ...metadata, backgroundTaskGeneration: requestedGeneration }
          const claimInput = {
            sessionID: nextSession.id,
            parentSessionID: ctx.sessionID,
            generation: requestedGeneration,
            description: params.description,
            parentMessageID: ctx.messageID,
            parentVariant: parentMessage.variant,
            wakeRequired: runInBackground,
          }
          let ownership = observedDeliveryMessageID
            ? yield* executions.claimAfterObservedTerminal({ ...claimInput, observedDeliveryMessageID })
            : yield* executions.claim(claimInput)
          if (ownership.status === "terminal") {
            const delivered = yield* deliverBackgroundTerminal({ executions, sessions, ops, terminal: ownership.info })
            if (ownership.info.generation === requestedGeneration) {
              if (!delivered) {
                if (!runInBackground) {
                  return yield* Effect.fail(new Error("Task result is being delivered by another OpenCode process"))
                }
                return {
                  waiting: "delivery" as const,
                  generation: ownership.info.generation,
                  metadata: { ...metadata, backgroundTaskGeneration: ownership.info.generation },
                }
              }
              return { replayed: true as const, terminal: ownership.info, metadata: nextMetadata }
            }
            const current = yield* executions.get(nextSession.id)
            if (
              current?.terminalDeliveredAt !== undefined &&
              current.wakeRequired &&
              current.state !== "cancelled" &&
              current.wakeClaimedAt === undefined
            ) {
              return yield* Effect.fail(
                new Error(
                  "The previous task result was delivered, but its parent wake is still in progress. Retry after it completes.",
                ),
              )
            }
            if (current?.terminalDeliveredAt === undefined && !runInBackground) {
              return yield* Effect.fail(new Error("Task result is being delivered by another OpenCode process"))
            }
            ownership = yield* executions.claim(claimInput)
          }
          if (ownership.status === "owned") {
            if (!runInBackground) {
              return yield* Effect.fail(new Error("Task is already running in another OpenCode process"))
            }
            return {
              waiting: "execution" as const,
              generation: ownership.info.generation,
              metadata: { ...metadata, backgroundTaskGeneration: ownership.info.generation },
            }
          }
          if (ownership.status === "terminal") {
            if (
              ownership.info.terminalDeliveredAt !== undefined &&
              ownership.info.wakeRequired &&
              ownership.info.state !== "cancelled" &&
              ownership.info.wakeClaimedAt === undefined
            ) {
              return yield* Effect.fail(
                new Error(
                  "The previous task result was delivered, but its parent wake is still in progress. Retry after it completes.",
                ),
              )
            }
            if (!runInBackground) {
              return yield* Effect.fail(new Error("Task result is being delivered by another OpenCode process"))
            }
            return {
              waiting: "delivery" as const,
              generation: ownership.info.generation,
              metadata: { ...metadata, backgroundTaskGeneration: ownership.info.generation },
            }
          }
          const info = yield* background.start({
            id: nextSession.id,
            type: id,
            title: params.description,
            metadata: nextMetadata,
            onPromote: executions.requireWake({ sessionID: nextSession.id, generation: requestedGeneration }).pipe(
              Effect.andThen(
                Effect.all(
                  [
                    ctx.metadata({
                      title: params.description,
                      metadata: { ...nextMetadata, background: true, jobId: nextSession.id },
                    }),
                    notify(nextSession.id, requestedGeneration),
                  ],
                  { discard: true },
                ),
              ),
            ),
            run: ownedRun(requestedGeneration),
          })
          yield* ctx.metadata({ title: params.description, metadata: nextMetadata })
          return { extended: false as const, generation: requestedGeneration, metadata: nextMetadata, info }
        }),
      )

      if (dispatch.terminal !== undefined) {
        if (dispatch.terminal.state === "error") {
          return yield* Effect.fail(new Error(dispatch.terminal.error ?? "Task failed"))
        }
        if (dispatch.terminal.state === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
        return {
          title: params.description,
          metadata: {
            ...dispatch.metadata,
            ...(runInBackground
              ? {
                  background: true,
                  jobId: nextSession.id,
                  backgroundTaskState: dispatch.terminal.state,
                }
              : {}),
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "completed",
            text: dispatch.terminal.output ?? "",
          }),
        }
      }

      if (dispatch.extended) {
        return {
          title: params.description,
          metadata: {
            ...dispatch.metadata,
            background: true,
            backgroundTaskState: "waiting",
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      if (dispatch.waiting) {
        const text =
          dispatch.waiting === "delivery"
            ? "Another OpenCode process is delivering this task result. It will be delivered automatically; do not relaunch it."
            : "This task is already running in another OpenCode process. It will notify you automatically when it finishes."
        return {
          title: params.description,
          metadata: {
            ...dispatch.metadata,
            background: true,
            backgroundTaskState: "waiting",
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary:
              dispatch.waiting === "delivery"
                ? "Background task delivery in progress"
                : "Background task already running",
            text,
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
            const terminal = yield* settleResult(result, dispatch.generation)
            if (terminal && terminal.state !== "running") {
              yield* background.evict(nextSession.id)
              const claimed = yield* executions.claimDelivery({
                sessionID: terminal.sessionID,
                generation: terminal.generation,
              })
              if (claimed) {
                yield* executions.completeDelivery({
                  sessionID: terminal.sessionID,
                  generation: terminal.generation,
                  token: claimed.token,
                })
                if (terminal.state !== "cancelled") {
                  const wake = yield* executions.claimWake({
                    sessionID: terminal.sessionID,
                    generation: terminal.generation,
                  })
                  if (wake) {
                    yield* executions.completeWake({
                      sessionID: terminal.sessionID,
                      generation: terminal.generation,
                      token: wake.token,
                    })
                  }
                }
              }
            }
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
    const executions = yield* BackgroundTaskExecution.Service
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
              const execution = yield* executions.get(taskID)
              const job = yield* background.get(taskID)
              const validJob =
                job?.type === id &&
                job.metadata?.parentSessionId === ctx.sessionID &&
                job.metadata?.sessionId === taskID &&
                job.metadata?.background === true
              const valid =
                session?.parentID === ctx.sessionID &&
                (execution ? execution.parentSessionID === ctx.sessionID : validJob)
              if (!valid) return { valid: false as const }
              return { valid: true as const, taskID, execution, job }
            }),
          )
          if (targets.some((target) => !target.valid)) {
            return yield* Effect.fail(new Error("Unable to stop one or more tasks"))
          }

          const statuses = yield* Effect.forEach(
            targets.flatMap((target) => (target.valid ? [target] : [])),
            Effect.fnUntraced(function* (target) {
              if (target.execution?.state === "running") {
                yield* executions.requestCancel(target.taskID)
              }
              if (target.execution?.state === "running" || target.job?.status === "running") {
                yield* ops.cancel(target.taskID)
              }
              const current = yield* executions.get(target.taskID)
              const job = yield* background.get(target.taskID)
              return {
                task_id: target.taskID,
                status:
                  current?.state === "running" && current.cancelRequestedAt !== undefined
                    ? "cancelled"
                    : (current?.state ?? job?.status),
              }
            }),
            { concurrency: "unbounded" },
          )
          const durable = (yield* executions.listRunning(ctx.sessionID))
            .filter((execution) => execution.cancelRequestedAt === undefined)
            .map((execution) => ({ task_id: execution.sessionID, description: execution.description }))
          const durableIDs = new Set(durable.map((task) => task.task_id))
          const active_tasks = durable.concat(
            (yield* background.list())
              .filter(
                (job) =>
                  job.status === "running" &&
                  job.type === id &&
                  job.metadata?.parentSessionId === ctx.sessionID &&
                  job.metadata?.background === true &&
                  !durableIDs.has(SessionID.make(job.id)),
              )
              .map((job) => ({ task_id: SessionID.make(job.id), description: job.title ?? "Background task" })),
          )

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
