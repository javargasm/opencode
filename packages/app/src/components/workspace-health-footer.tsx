import { Component, createMemo, createSignal, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useSync } from "@/context/sync"
import { useSDK } from "@/context/sdk"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogStatus } from "./dialog-status"

export const WORKSPACE_HEALTH_FOOTER_MOUNT_ID = "opencode-workspace-health-footer"

export function findWorkspaceHealthFooterMount(root: ParentNode) {
  const mount = root.querySelector(`#${WORKSPACE_HEALTH_FOOTER_MOUNT_ID}`)
  return mount instanceof HTMLElement ? mount : undefined
}

export const WorkspaceHealthFooter: Component = () => {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const [mount, setMount] = createSignal<HTMLElement>()

  onMount(() => setMount(findWorkspaceHealthFooterMount(document)))

  const dir = () => sdk().directory

  const directoryDisplay = createMemo(() => {
    const d = dir()
    if (!d) return ""
    const home = "/Users/"
    if (d.startsWith(home)) {
      const parts = d.slice(home.length).split("/")
      parts.shift() // remove username
      return "~/" + parts.join("/")
    }
    return d
  })

  const mcpStats = createMemo(() => {
    const s = sync()
    const mcps = Object.values(s.data.mcp ?? {})
    const total = mcps.length
    const connected = mcps.filter((m) => m.status === "connected").length
    const failed = mcps.filter((m) => m.status === "failed" || m.status === "needs_client_registration").length
    return { total, connected, failed }
  })

  const lspCount = createMemo(() => sync().data.lsp.length)

  const pendingPermissions = createMemo(() => {
    const s = sync()
    const perms = Object.values(s.data.permission ?? {}).flat()
    return perms.length
  })

  const openStatus = () => {
    dialog.show(() => <DialogStatus />)
  }

  return (
    <Show when={dir() && mount()}>
      <Portal mount={mount()!}>
        <div
          class="h-6 w-full px-3 flex items-center justify-between border-t border-border-weak-base/60 bg-background-base/80 backdrop-blur-sm text-11-regular text-text-weaker select-none shrink-0 z-20"
          data-component="workspace-health-footer"
        >
          <div class="flex items-center gap-3 min-w-0">
            <Show when={directoryDisplay()}>
              <span class="truncate max-w-[200px] text-text-weak" title={dir()}>
                {directoryDisplay()}
              </span>
            </Show>

            <Show when={pendingPermissions() > 0}>
              <span class="inline-flex items-center gap-1 text-text-warning font-medium">
                <span>△</span>
                <span>{pendingPermissions()} permissions</span>
              </span>
            </Show>
          </div>

          <div class="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={openStatus}
              class="flex items-center gap-2 hover:text-text-base transition-colors cursor-pointer py-0.5 px-1 rounded hover:bg-surface-hover/60"
              title="Open Workspace Status"
            >
              <span class="inline-flex items-center gap-1">
                <span
                  class={`size-1.5 rounded-full ${lspCount() > 0 ? "bg-icon-success-base" : "bg-border-weak-base"}`}
                />
                <span>{lspCount()} LSP</span>
              </span>

              <span class="inline-flex items-center gap-1">
                <span
                  class={`size-1.5 rounded-full ${
                    mcpStats().failed > 0
                      ? "bg-icon-error-base"
                      : mcpStats().connected > 0
                        ? "bg-icon-success-base"
                        : "bg-border-weak-base"
                  }`}
                />
                <span>{mcpStats().total} MCP</span>
              </span>
            </button>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
