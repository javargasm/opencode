import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"

export function getActiveDescendantCount(
  sessionID: string | undefined,
  sessions: Pick<Session, "id" | "parentID">[],
  statuses: Record<string, SessionStatus | undefined>,
): number {
  if (!sessionID) return 0
  const byID = new Map(sessions.map((session) => [session.id, session]))
  return sessions.filter((session) => {
    const status = statuses[session.id]
    if (!status || status.type === "idle") return false

    const seen = new Set<string>()
    let parentID = session.parentID
    while (parentID && !seen.has(parentID)) {
      if (parentID === sessionID) return true
      seen.add(parentID)
      parentID = byID.get(parentID)?.parentID
    }
    return false
  }).length
}

export function sessionActivityLabel(activeDescendantCount: number): string | undefined {
  if (activeDescendantCount <= 0) return undefined
  if (activeDescendantCount === 1) return "1 subagent active"
  return `${activeDescendantCount} subagents active`
}
