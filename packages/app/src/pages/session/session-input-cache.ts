import type { SessionInputAdmitted, SessionInputPending } from "@opencode-ai/sdk/v2/client"

/**
 * Project a confirmed admission response into the pending-input query cache.
 * The server remains authoritative: callers must invalidate the query after
 * this update so the cache is reconciled with the durable inbox.
 */
export function mergePendingSessionInput(
  current: readonly SessionInputPending[] | undefined,
  admitted: SessionInputAdmitted,
): SessionInputPending[] {
  if (admitted.delivery === "legacy") return [...(current ?? [])]
  if (admitted.promotedSeq !== undefined) return (current ?? []).filter((item) => item.id !== admitted.id)

  const pending: SessionInputPending = {
    admittedSeq: admitted.admittedSeq,
    id: admitted.id,
    sessionID: admitted.sessionID,
    prompt: admitted.prompt,
    delivery: admitted.delivery,
    timeCreated: admitted.timeCreated,
  }

  return [...(current ?? []).filter((item) => item.id !== pending.id), pending].sort(
    (left, right) => left.admittedSeq - right.admittedSeq,
  )
}
