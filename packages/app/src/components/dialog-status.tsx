import { Component, createMemo, For, Match, Show, Switch } from "solid-js"
import { useOptionalSync } from "@/context/sync"
import { Dialog } from "@opencode-ai/ui/dialog"

export const DialogStatus: Component = () => {
  const sync = useOptionalSync()

  const enabledFormatters = createMemo(() => {
    const s = sync()
    if (!s) return []
    const formatterConfig = s.data.config?.formatter
    if (!formatterConfig) return []
    if (formatterConfig === true) return [{ name: "Built-in Formatters" }]
    return Object.entries(formatterConfig)
      .filter(([_, conf]) => !conf.disabled)
      .map(([name]) => ({ name }))
  })

  const plugins = createMemo(() => {
    const s = sync()
    if (!s) return []
    const list = s.data.config?.plugin ?? []
    const result = list.map((item) => {
      const value = typeof item === "string" ? item : item[0]
      if (value.startsWith("file://")) {
        const parts = value.split("/")
        const filename = parts.pop() || value
        if (!filename.includes(".")) return { name: filename }
        const basename = filename.split(".")[0]
        if (basename === "index") {
          const dirname = parts.pop()
          const name = dirname || basename
          return { name }
        }
        return { name: basename }
      }
      const index = value.lastIndexOf("@")
      if (index <= 0) return { name: value, version: "latest" }
      const name = value.substring(0, index)
      const version = value.substring(index + 1)
      return { name, version }
    })
    return result.toSorted((a, b) => a.name.localeCompare(b.name))
  })

  const mcpEntries = createMemo(() => Object.entries(sync()?.data.mcp ?? {}))
  const lspEntries = createMemo(() => sync()?.data.lsp ?? [])

  return (
    <Dialog title="Status" size="large">
      <Show
        when={sync()}
        fallback={
          <div class="py-12 flex flex-col items-center justify-center text-center text-text-weaker text-13-regular">
            No active workspace selected
          </div>
        }
      >
        <div class="px-4 pb-4 flex flex-col gap-5 text-13-regular max-h-[70vh] overflow-y-auto">
          {/* MCP Servers */}
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-weak uppercase tracking-wider">
              {mcpEntries().length} MCP Servers
            </div>
            <Show
              when={mcpEntries().length > 0}
              fallback={<div class="text-text-weaker text-12-regular">No MCP Servers configured</div>}
            >
              <div class="flex flex-col gap-1.5 pl-1">
                <For each={mcpEntries()}>
                  {([key, item]) => {
                    const dotColor = () => {
                      switch (item.status) {
                        case "connected":
                          return "bg-icon-success-base"
                        case "failed":
                        case "needs_client_registration":
                          return "bg-icon-error-base"
                        case "needs_auth":
                          return "bg-icon-warning-base"
                        default:
                          return "bg-border-weak-base"
                      }
                    }

                    return (
                      <div class="flex items-start gap-2.5 py-1 px-2 rounded-md hover:bg-surface-hover/50">
                        <span class={`inline-block size-2 rounded-full mt-1.5 shrink-0 ${dotColor()}`} />
                        <div class="flex flex-col min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="font-medium text-text-base">{key}</span>
                            <span class="text-11-regular text-text-weaker">
                              <Switch fallback={item.status}>
                                <Match when={item.status === "connected"}>Connected</Match>
                                <Match when={item.status === "disabled"}>Disabled</Match>
                                <Match when={(item.status as string) === "needs_auth"}>Needs authentication</Match>
                                <Match when={(item.status as string) === "failed"}>Failed</Match>
                              </Switch>
                            </span>
                          </div>
                          <Show when={item.status === "failed" && (item as { error?: string }).error}>
                            <span class="text-11-regular text-text-error break-words">
                              {(item as { error?: string }).error}
                            </span>
                          </Show>
                        </div>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </div>

          {/* LSP Servers */}
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-weak uppercase tracking-wider">
              {lspEntries().length} LSP Servers
            </div>
            <Show
              when={lspEntries().length > 0}
              fallback={<div class="text-text-weaker text-12-regular">No LSP Servers running</div>}
            >
              <div class="flex flex-col gap-1.5 pl-1">
                <For each={lspEntries()}>
                  {(item) => (
                    <div class="flex items-start gap-2.5 py-1 px-2 rounded-md hover:bg-surface-hover/50">
                      <span
                        class={`inline-block size-2 rounded-full mt-1.5 shrink-0 ${
                          item.status === "connected" ? "bg-icon-success-base" : "bg-icon-error-base"
                        }`}
                      />
                      <div class="flex items-center gap-2 min-w-0 flex-1">
                        <span class="font-medium text-text-base">{item.id}</span>
                        <span class="text-11-regular text-text-weaker truncate">{item.root}</span>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Formatters */}
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-weak uppercase tracking-wider">
              {enabledFormatters().length} Formatters
            </div>
            <Show
              when={enabledFormatters().length > 0}
              fallback={<div class="text-text-weaker text-12-regular">No Formatters enabled</div>}
            >
              <div class="flex flex-col gap-1.5 pl-1">
                <For each={enabledFormatters()}>
                  {(item) => (
                    <div class="flex items-center gap-2.5 py-1 px-2 rounded-md hover:bg-surface-hover/50">
                      <span class="inline-block size-2 rounded-full bg-icon-success-base shrink-0" />
                      <span class="font-medium text-text-base">{item.name}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>

          {/* Plugins */}
          <div class="flex flex-col gap-2">
            <div class="text-12-medium text-text-weak uppercase tracking-wider">
              {plugins().length} Plugins
            </div>
            <Show
              when={plugins().length > 0}
              fallback={<div class="text-text-weaker text-12-regular">No Plugins loaded</div>}
            >
              <div class="flex flex-col gap-1.5 pl-1">
                <For each={plugins()}>
                  {(item) => (
                    <div class="flex items-center gap-2.5 py-1 px-2 rounded-md hover:bg-surface-hover/50">
                      <span class="inline-block size-2 rounded-full bg-icon-success-base shrink-0" />
                      <span class="font-medium text-text-base">{item.name}</span>
                      <Show when={item.version}>
                        <span class="text-11-regular text-text-weaker">@{item.version}</span>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </Dialog>
  )
}
