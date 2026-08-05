export type BackgroundTaskUpdate = "running" | "completed" | "error" | "cancelled" | undefined
export type BackgroundTasks = Map<string, string | undefined>

export function applyBackgroundTaskPart(tasks: BackgroundTasks, input: unknown): BackgroundTaskUpdate {
  const part = record(input)
  if (!part) return undefined

  if (part.type === "tool" && part.tool === "task") {
    const state = record(part.state)
    const metadata = record(state?.metadata)
    const taskID = text(metadata?.sessionId)
    const generation = text(metadata?.backgroundTaskGeneration)
    if (metadata?.background !== true || !taskID) return undefined

    if (state?.status === "running" || state?.status === "completed") {
      tasks.set(taskID, generation)
      return "running"
    }
    if (state?.status === "error" || state?.status === "cancelled") {
      if (!remove(tasks, taskID, generation)) return undefined
      return state.status
    }
    return undefined
  }

  const metadata = record(part.metadata)
  const taskID = text(metadata?.backgroundTaskID)
  const generation = text(metadata?.backgroundTaskGeneration)
  const state = text(metadata?.backgroundTaskState)
  if (part.type !== "text" || part.synthetic !== true || !taskID) return undefined
  if (state !== "completed" && state !== "error" && state !== "cancelled") return undefined
  if (!remove(tasks, taskID, generation)) return undefined
  return state
}

export function projectBackgroundTasks(input: unknown) {
  const messages = Array.isArray(input) ? input : []
  const parts = messages
    .flatMap((message) => {
      const item = record(message)
      return Array.isArray(item?.parts) ? item.parts : []
    })
    .map((part, index) => ({ index, part, id: text(record(part)?.id) }))
    .toSorted((a, b) => (a.id && b.id ? a.id.localeCompare(b.id) : a.index - b.index))
  const tasks: BackgroundTasks = new Map()
  for (const part of parts) applyBackgroundTaskPart(tasks, part.part)
  return tasks
}

export function reconcileBackgroundTasks(tasks: BackgroundTasks, residentTaskIDs: readonly string[]) {
  const resident = new Set(residentTaskIDs)
  for (const taskID of tasks.keys()) {
    if (!resident.has(taskID)) tasks.delete(taskID)
  }
  return tasks
}

function remove(tasks: BackgroundTasks, taskID: string, generation: string | undefined) {
  if (!tasks.has(taskID) || tasks.get(taskID) !== generation) return false
  tasks.delete(taskID)
  return true
}

function record(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return Object.fromEntries(Object.entries(input))
}

function text(input: unknown) {
  return typeof input === "string" ? input : undefined
}
