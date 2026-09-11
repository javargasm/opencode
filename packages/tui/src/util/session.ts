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

export function sessionActivityLabel(_activity: SessionActivity, activeDescendantCount: number) {
  if (activeDescendantCount > 0) return `↳ Subagent active(${activeDescendantCount})`
}
