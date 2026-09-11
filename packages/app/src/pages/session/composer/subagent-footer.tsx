import { createMemo, Show } from "solid-js"
import { useNavigate, useParams } from "@solidjs/router"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"

export function SubagentFooter(props: {
  sessionID: string
  parentID: string
  openParent: () => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const navigate = useNavigate()
  const params = useParams()
  const providers = useProviders(() => sdk().directory)

  const session = createMemo(() => sync().session.get(props.sessionID))
  const messages = createMemo(() => sync().data.message[props.sessionID] ?? [])
  const isBusy = createMemo(() => {
    const status = sync().data.session_status?.[props.sessionID]
    return !!status && status.type !== "idle"
  })

  const siblings = createMemo(() => {
    const parentID = props.parentID
    if (!parentID) return []
    return sync()
      .data.session.filter((s) => s.parentID === parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
  })

  const subagentInfo = createMemo(() => {
    const s = session()
    const list = siblings()
    const idx = list.findIndex((x) => x.id === props.sessionID)
    const agentMatch = s?.title?.match(/@(\w+) subagent/)
    const rawLabel = agentMatch ? agentMatch[1] : s?.agent || "subagent"
    const label = rawLabel.charAt(0).toUpperCase() + rawLabel.slice(1)

    return {
      label,
      index: idx >= 0 ? idx + 1 : 0,
      total: list.length,
      prev: idx > 0 ? list[idx - 1]?.id : undefined,
      next: idx >= 0 && idx < list.length - 1 ? list[idx + 1]?.id : undefined,
    }
  })

  const usage = createMemo(() => {
    const msgList = messages()
    const last = msgList.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && (item.tokens?.output ?? 0) > 0,
    )
    if (!last || !last.tokens) return undefined

    const tokens =
      (last.tokens.input ?? 0) +
      (last.tokens.output ?? 0) +
      (last.tokens.reasoning ?? 0) +
      (last.tokens.cache?.read ?? 0) +
      (last.tokens.cache?.write ?? 0)
    if (tokens <= 0) return undefined

    const providerMatch = providers.all().get(last.providerID)
    const model = providerMatch?.models?.[last.modelID]
    const pct = model?.limit?.context ? Math.round((tokens / model.limit.context) * 100) : undefined
    const cost = session()?.cost ?? 0

    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 3,
    })

    const tokenFormatted = new Intl.NumberFormat("en-US").format(tokens)

    return {
      context: pct !== undefined ? `${tokenFormatted} (${pct}%)` : tokenFormatted,
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const goToSession = (targetID: string) => {
    navigate(
      params.serverKey
        ? sessionHref(requireServerKey(params.serverKey), targetID)
        : legacySessionHref(sdk().directory, targetID),
    )
  }

  const handleAbort = () => {
    void sdk().api.session.interrupt({ sessionID: props.sessionID }).catch(() => {})
  }

  return (
    <div
      data-component="subagent-footer"
      class="w-full rounded-[12px] border border-border-weak-base bg-background-base p-3 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shadow-xs"
    >
      <div class="flex items-center gap-2 flex-wrap min-w-0">
        <span class="font-medium text-14 text-text-strong">{subagentInfo().label}</span>
        <Show when={subagentInfo().total > 0}>
          <span class="text-13 text-text-weak">
            ({subagentInfo().index} of {subagentInfo().total})
          </span>
        </Show>
        <Show when={usage()}>
          {(u) => (
            <span class="text-12 text-text-weak font-mono">
              {[u().context, u().cost].filter(Boolean).join(" · ")}
            </span>
          )}
        </Show>
        <Show when={isBusy()}>
          <Button size="small" variant="secondary" onClick={handleAbort} class="ml-1 h-6 px-2 text-12">
            Stop
          </Button>
        </Show>
      </div>

      <div class="flex items-center gap-1.5 shrink-0 justify-end">
        <Button size="small" variant="ghost" onClick={props.openParent} class="h-7 px-2.5 text-12">
          <Icon name="arrow-up" size="small" class="mr-1" />
          Parent
        </Button>
        <Button
          size="small"
          variant="ghost"
          disabled={!subagentInfo().prev}
          onClick={() => subagentInfo().prev && goToSession(subagentInfo().prev!)}
          class="h-7 px-2 text-12"
        >
          <Icon name="chevron-left" size="small" class="mr-0.5" />
          Prev
        </Button>
        <Button
          size="small"
          variant="ghost"
          disabled={!subagentInfo().next}
          onClick={() => subagentInfo().next && goToSession(subagentInfo().next!)}
          class="h-7 px-2 text-12"
        >
          Next
          <Icon name="chevron-right" size="small" class="ml-0.5" />
        </Button>
      </div>
    </div>
  )
}
