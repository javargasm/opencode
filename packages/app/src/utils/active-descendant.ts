import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"

export function getActiveDescendantCount(
  sessionID: string | undefined,
  sessions: Pick<Session, "id" | "parentID">[],
  statuses: Record<string, SessionStatus | undefined>,
): number {
  if (!sessionID) return 0
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    if (!session.parentID) continue
    const childIDs = children.get(session.parentID)
    if (childIDs) childIDs.push(session.id)
    else children.set(session.parentID, [session.id])
  }

  const seen = new Set([sessionID])
  const pending = [...(children.get(sessionID) ?? [])]
  let count = 0

  while (pending.length > 0) {
    const childID = pending.pop()
    if (childID === undefined || seen.has(childID)) continue

    seen.add(childID)
    const status = statuses[childID]
    if (status && status.type !== "idle") count++

    pending.push(...(children.get(childID) ?? []))
  }

  return count
}

export function sessionActivityLabel(activeDescendantCount: number): string | undefined {
  if (activeDescendantCount <= 0) return undefined
  if (activeDescendantCount === 1) return "1 subagent active"
  return `${activeDescendantCount} subagents active`
}
