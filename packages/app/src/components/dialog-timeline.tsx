import { Component, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useOptionalSync } from "@/context/sync"
import { useOptionalSDK } from "@/context/sdk"
import { usePrompt } from "@/context/prompt"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@/utils/toast"
import { extractPromptFromParts } from "@/utils/prompt"
import { sessionHrefForRoute } from "@/utils/session-route"
import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Part, TextPart as SDKTextPart } from "@opencode-ai/sdk/v2/client"

interface TimelineTurn {
  id: string
  turnIndex: number
  text: string
  fullText: string
  time: string
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

export async function loadTimelineHistory(input: {
  sessionID: () => string | undefined
  history: {
    more: (sessionID: string) => boolean
    loading: (sessionID: string) => boolean
    loadMore: (sessionID: string) => Promise<void>
  }
  active?: () => boolean
}) {
  const id = input.sessionID()
  if (!id || input.history.loading(id)) return

  while (input.active?.() !== false && input.sessionID() === id && input.history.more(id) && !input.history.loading(id)) {
    await input.history.loadMore(id)
  }
}

export function timelineTurnText(parts: Part[], attachmentName: string) {
  const fullText = parts
    .filter((part): part is SDKTextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join(" ")
    .trim()
  if (fullText) return fullText

  return parts
    .flatMap((part) => {
      if (part.type === "file") return [part.source?.text.value.trim() || part.filename?.trim() || attachmentName]
      if (part.type === "agent") return [part.source?.value.trim() || `@${part.name}`]
      return []
    })
    .join(" ")
    .trim()
}

export const DialogTimeline: Component<{ sessionID?: string }> = (props) => {
  const params = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const sync = useOptionalSync()
  const sdk = useOptionalSDK()
  const prompt = usePrompt()
  const dialog = useDialog()
  const language = useLanguage()

  const [search, setSearch] = createSignal("")
  const [selectedTurnId, setSelectedTurnId] = createSignal<string>()

  const sessionID = () => props.sessionID ?? params.id
  const historyLoads = new Set<string>()
  let active = true

  onCleanup(() => {
    active = false
  })

  createEffect(() => {
    const id = sessionID()
    const s = sync()
    if (!id || !s || historyLoads.has(id) || !s.session.history.more(id) || s.session.history.loading(id)) return

    historyLoads.add(id)
    void loadTimelineHistory({ sessionID, history: s.session.history, active: () => active })
      .catch(() => {})
      .finally(() => historyLoads.delete(id))
  })

  const turns = createMemo((): TimelineTurn[] => {
    const id = sessionID()
    const s = sync()
    if (!id || !s) return []

    const msgs = s.data.message[id] ?? []
    const result: TimelineTurn[] = []
    let turnCount = 0

    for (const msg of msgs) {
      if (msg.role !== "user") continue
      turnCount++

      const parts = s.data.part[msg.id] ?? []
      const fullText = timelineTurnText(parts, language.t("common.attachment"))
      if (!fullText) continue

      result.push({
        id: msg.id,
        turnIndex: turnCount,
        text: fullText.replace(/\n/g, " ").slice(0, 140),
        fullText,
        time: formatTime(new Date(msg.time.created)),
      })
    }

    return result
  })

  const filteredTurns = createMemo(() => {
    const q = search().toLowerCase().trim()
    const all = turns()
    if (!q) return all
    return all.filter((t) => t.fullText.toLowerCase().includes(q))
  })

  const jumpToMessage = (messageID: string, e?: MouseEvent) => {
    e?.stopPropagation()
    dialog.close()
    navigate(`${location.pathname}${location.search}#message-${messageID}`, { replace: true })
  }

  const forkFromTurn = async (turn: TimelineTurn, e: MouseEvent) => {
    e.stopPropagation()
    const id = sessionID()
    const s = sync()
    const client = sdk?.()
    if (!id || !s || !client) return

    const parts = s.data.part[turn.id] ?? []
    const restored = extractPromptFromParts(parts, {
      directory: client.directory,
      attachmentName: language.t("common.attachment"),
    })
    const dir = base64Encode(client.directory)

    try {
      const forked = await client.api.session.fork({ sessionID: id, messageID: turn.id })
      dialog.close()
      prompt.set(restored, undefined, { dir, id: forked.id })
      navigate(sessionHrefForRoute(params.serverKey, client.directory, forked.id))
      showToast({ title: "Session forked", variant: "success" })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message, variant: "error" })
    }
  }

  const copyPrompt = async (text: string, e: MouseEvent) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(text)
      showToast({ title: "Prompt copied to clipboard", variant: "success" })
    } catch {
      showToast({ title: "Failed to copy prompt", variant: "error" })
    }
  }

  return (
    <Dialog title={`Timeline (${turns().length} turns)`} size="large">
      <div class="px-4 pb-4 flex flex-col gap-3 max-h-[75vh]">
        <Show when={turns().length > 5}>
          <input
            type="text"
            autofocus
            placeholder="Search timeline..."
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            class="w-full px-3 py-2 text-13-regular bg-surface-base border border-border-weak-base rounded-md focus:outline-none focus:border-border-strong-base"
          />
        </Show>

        <div class="flex flex-col overflow-y-auto divide-y divide-border-weak-base/40">
          <Show
            when={filteredTurns().length > 0}
            fallback={
              <div class="py-12 flex flex-col items-center justify-center text-center text-text-weaker text-13-regular">
                No turns found
              </div>
            }
          >
            <For each={filteredTurns()}>
              {(turn) => (
                <div
                  class="group py-3 px-2 flex items-center justify-between gap-3 hover:bg-surface-hover/60 rounded-md transition-colors cursor-pointer"
                  classList={{
                    "bg-surface-hover/80": selectedTurnId() === turn.id,
                  }}
                  onMouseEnter={() => setSelectedTurnId(turn.id)}
                  onClick={() => jumpToMessage(turn.id)}
                >
                  <div class="flex items-start gap-3 min-w-0 flex-1">
                    <span class="inline-flex items-center justify-center size-6 rounded-full bg-surface-raised-base text-11-medium text-text-weak shrink-0 mt-0.5">
                      {turn.turnIndex}
                    </span>
                    <div class="flex flex-col min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="text-13-medium text-text-base truncate font-sans">{turn.text}</span>
                      </div>
                      <span class="text-11-regular text-text-weaker">{turn.time}</span>
                    </div>
                  </div>

                  <div class="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100">
                    <IconButton
                      icon="copy"
                      size="small"
                      variant="ghost"
                      title="Copy prompt"
                      onClick={(e: MouseEvent) => copyPrompt(turn.fullText, e)}
                    />
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={(e: MouseEvent) => forkFromTurn(turn, e)}
                      title="Fork session from this turn"
                    >
                      Fork
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={(e: MouseEvent) => jumpToMessage(turn.id, e)}
                      title="Scroll to message in session"
                    >
                      Jump
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
