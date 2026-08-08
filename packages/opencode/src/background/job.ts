import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { InstanceRef } from "@/effect/instance-ref"
import { registerDisposer } from "@/effect/instance-registry"
import { BackgroundTaskExecution } from "@/background/task-execution"
import { SessionID } from "@/session/schema"
import { Location } from "@opencode-ai/core/location"
import { Context, Effect, Layer, Option, ScopedCache } from "effect"

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    const executions = yield* BackgroundTaskExecution.Service
    const cache = yield* ScopedCache.make<string, CoreBackgroundJob.Interface>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () => CoreBackgroundJob.make,
    })
    const off = registerDisposer((directory) => Effect.runPromise(ScopedCache.invalidate(cache, directory)))
    yield* Effect.addFinalizer(() => Effect.sync(off))
    const use = <A>(select: (jobs: CoreBackgroundJob.Interface) => Effect.Effect<A>) =>
      Effect.gen(function* () {
        const instance = yield* InstanceRef
        const location = Context.getOption(yield* Effect.context(), Location.Service)
        const directory = instance?.directory ?? Option.getOrThrow(location).directory
        return yield* select(yield* ScopedCache.get(cache, directory))
      })
    return CoreBackgroundJob.Service.of({
      list: () => use((jobs) => jobs.list()),
      listForParent: (parentSessionID) =>
        use((jobs) =>
          Effect.gen(function* () {
            const [resident, durable] = yield* Effect.all([
              jobs.listForParent(parentSessionID),
              executions.listForParent(SessionID.make(parentSessionID)),
            ])
            return [
              ...new Set([...resident, ...durable.filter((task) => task.wakeRequired).map((task) => task.sessionID)]),
            ].toSorted()
          }),
        ),
      get: (id) => use((jobs) => jobs.get(id)),
      start: (input) => use((jobs) => jobs.start(input)),
      extend: (input) => use((jobs) => jobs.extend(input)),
      wait: (input) => use((jobs) => jobs.wait(input)),
      waitForPromotion: (id) => use((jobs) => jobs.waitForPromotion(id)),
      promote: (id) => use((jobs) => jobs.promote(id)),
      cancel: (id) => use((jobs) => jobs.cancel(id)),
      evict: (id) => use((jobs) => jobs.evict(id)),
    })
  }),
)

export const node = LayerNode.make({ service: CoreBackgroundJob.Service, layer, deps: [BackgroundTaskExecution.node] })

export * as BackgroundJob from "./job"
