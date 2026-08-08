import type { Session, SessionStatus } from "@opencode-ai/sdk/v2"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

export type SessionActivity = "idle" | "current" | "descendant"

export function isSessionActivityActive(activity: SessionActivity) {
  return activity !== "idle"
}

export function getSessionActivity(
  sessionID: string | undefined,
  sessions: Pick<Session, "id" | "parentID">[],
  statuses: Record<string, SessionStatus | undefined>,
): SessionActivity {
  if (!sessionID) return "idle"
  const status = statuses[sessionID]
  if (status && status.type !== "idle") return "current"

  return getActiveDescendantCount(sessionID, sessions, statuses) > 0 ? "descendant" : "idle"
}

export function getActiveDescendantCount(
  sessionID: string | undefined,
  sessions: Pick<Session, "id" | "parentID">[],
  statuses: Record<string, SessionStatus | undefined>,
) {
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

export function sessionActivityLabel(_activity: SessionActivity, activeDescendantCount: number) {
  if (activeDescendantCount > 0) return `↳ Subagent active(${activeDescendantCount})`
}
