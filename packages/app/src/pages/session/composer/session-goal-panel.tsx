import type { SessionGoalInfo, SessionGoalUpdate } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { createEffect, createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"

type GoalStatus = SessionGoalUpdate["status"]

const statuses: GoalStatus[] = ["active", "paused", "blocked", "complete"]

export function SessionGoalPanel(props: {
  sessionID: () => string
  goal: () => SessionGoalInfo | undefined
  onSave: (input: SessionGoalUpdate) => Promise<SessionGoalInfo>
}) {
  const language = useLanguage()
  const [objective, setObjective] = createSignal("")
  const [status, setStatus] = createSignal<GoalStatus>("active")
  const [reason, setReason] = createSignal("")
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  let currentSession: string | undefined
  let sourceVersion: string | undefined
  let saveVersion = 0

  const refresh = () => {
    const sessionID = props.sessionID()
    const goal = props.goal()
    if (sessionID !== currentSession) {
      currentSession = sessionID
      sourceVersion = undefined
      saveVersion++
      setDirty(false)
      setSaving(false)
    }

    const version = `${sessionID}\0${goal?.updatedAt ?? ""}`
    if (dirty() || sourceVersion === version) return
    sourceVersion = version
    setObjective(goal?.objective ?? "")
    setStatus(goal?.status ?? "active")
    setReason(goal?.reason ?? "")
  }

  createEffect(refresh)

  const isCurrentSave = (sessionID: string, version: number) => {
    if (version === saveVersion && sessionID === props.sessionID()) return true
    refresh()
    return false
  }

  const save = async () => {
    const nextObjective = objective().trim()
    if (!nextObjective || saving()) return

    const sessionID = props.sessionID()
    const version = ++saveVersion
    setSaving(true)
    // A route change can happen synchronously after submit but before this save yields.
    queueMicrotask(() => {
      if (sessionID !== props.sessionID()) refresh()
    })
    try {
      const next = await props.onSave({
        objective: nextObjective,
        status: status(),
        ...(reason().trim() ? { reason: reason().trim() } : {}),
      })
      if (!isCurrentSave(sessionID, version)) return
      sourceVersion = `${sessionID}\0${next.updatedAt}`
      setObjective(next.objective)
      setStatus(next.status)
      setReason(next.reason ?? "")
      setDirty(false)
    } catch {
      // The owner reports request errors and preserves this local draft.
    } finally {
      if (!isCurrentSave(sessionID, version)) return
      setSaving(false)
    }
  }

  const setField = <T,>(set: (value: T) => void, value: T) => {
    set(value)
    setDirty(true)
  }

  return (
    <section
      data-component="session-goal-panel"
      class="rounded-md border border-border-weak-base bg-background-base px-3 py-2.5 flex flex-col gap-2"
    >
      <div class="flex items-center gap-2">
        <span class="text-13-medium text-text-strong">{language.t("session.goal.title")}</span>
        <Show when={props.goal()}>
          {(goal) => (
            <span class="text-12-regular text-text-weak">
              {language.t(`session.goal.status.${goal().status}` as "session.goal.status.active")}
            </span>
          )}
        </Show>
      </div>
      <Show when={!props.goal()}>
        <div class="text-12-regular text-text-weak">{language.t("session.goal.empty")}</div>
      </Show>
      <label class="flex flex-col gap-1">
        <span class="text-12-medium text-text-weak">{language.t("session.goal.objective")}</span>
        <textarea
          rows={2}
          class="w-full resize-y rounded border border-border-weak-base bg-background-base px-2 py-1.5 text-13-regular text-text-strong outline-none focus:border-border-strong-base"
          value={objective()}
          aria-label={language.t("session.goal.objective")}
          onInput={(event) => setField(setObjective, event.currentTarget.value)}
        />
      </label>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label class="flex flex-col gap-1">
          <span class="text-12-medium text-text-weak">{language.t("session.goal.status")}</span>
          <select
            class="h-8 rounded border border-border-weak-base bg-background-base px-2 text-13-regular text-text-strong outline-none focus:border-border-strong-base"
            value={status()}
            aria-label={language.t("session.goal.status")}
            onChange={(event) => setField(setStatus, event.currentTarget.value as GoalStatus)}
          >
            {statuses.map((item) => (
              <option value={item}>{language.t(`session.goal.status.${item}` as "session.goal.status.active")}</option>
            ))}
          </select>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-12-medium text-text-weak">{language.t("session.goal.reason")}</span>
          <input
            class="h-8 rounded border border-border-weak-base bg-background-base px-2 text-13-regular text-text-strong outline-none focus:border-border-strong-base"
            value={reason()}
            aria-label={language.t("session.goal.reason")}
            onInput={(event) => setField(setReason, event.currentTarget.value)}
          />
        </label>
      </div>
      <div class="flex justify-end">
        <Button size="small" disabled={saving() || objective().trim().length === 0} onClick={() => void save()}>
          {saving()
            ? language.t("common.saving")
            : props.goal()
              ? language.t("common.save")
              : language.t("session.goal.set")}
        </Button>
      </div>
    </section>
  )
}
