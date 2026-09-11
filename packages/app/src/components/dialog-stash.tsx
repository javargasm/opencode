import { Component, For, Show } from "solid-js"
import { usePromptStash, type StashEntry } from "@/context/prompt-stash"
import { usePrompt } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { getRelativeTime } from "@/utils/time"

function getStashPreview(input: string, maxLength: number = 60): string {
  const firstLine = input.split("\n")[0].trim()
  if (firstLine.length <= maxLength) return firstLine
  return firstLine.slice(0, maxLength) + "..."
}

export const DialogStash: Component<{ onSelect?: (entry: StashEntry) => void }> = (props) => {
  const stash = usePromptStash()
  const prompt = usePrompt()
  const language = useLanguage()
  const dialog = useDialog()

  const handleRestore = (entry: StashEntry) => {
    if (props.onSelect) {
      props.onSelect(entry)
    } else {
      if (entry.parts && entry.parts.length > 0) {
        prompt.set(entry.parts, entry.input.length)
      } else {
        prompt.set(
          [{ type: "text", content: entry.input, start: 0, end: entry.input.length }],
          entry.input.length,
        )
      }
    }
    dialog.close()
  }

  const handleDelete = (id: string, e: MouseEvent) => {
    e.stopPropagation()
    stash.remove(id)
  }

  return (
    <Dialog title="Prompt Stash" size="large">
      <div class="px-4 pb-4 flex flex-col gap-3 max-h-[70vh] overflow-y-auto">
        <Show
          when={stash.list().length > 0}
          fallback={
            <div class="py-12 flex flex-col items-center justify-center text-center gap-2 text-text-weaker">
              <span class="text-14-medium text-text-weak">No stashed prompts</span>
              <span class="text-12-regular max-w-sm">
                Save drafts with the <code class="px-1.5 py-0.5 rounded bg-surface-hover font-mono text-11-regular">/stash</code> command to quickly switch tasks without losing your current prompt.
              </span>
            </div>
          }
        >
          <div class="flex flex-col divide-y divide-border-weak-base/50">
            <For each={stash.list()}>
              {(entry) => {
                const lineCount = (entry.input.match(/\n/g)?.length ?? 0) + 1
                return (
                  <div
                    class="group py-3 px-2 flex items-center justify-between gap-3 hover:bg-surface-hover/60 rounded-md transition-colors cursor-pointer"
                    onClick={() => handleRestore(entry)}
                  >
                    <div class="flex flex-col min-w-0 flex-1 gap-1">
                      <div class="flex items-center gap-2">
                        <span class="text-13-medium text-text-base truncate font-mono">
                          {getStashPreview(entry.input)}
                        </span>
                        <Show when={lineCount > 1}>
                          <span class="text-11-regular text-text-weaker shrink-0 bg-surface-hover px-1.5 py-0.5 rounded">
                            ~{lineCount} lines
                          </span>
                        </Show>
                      </div>
                      <span class="text-11-regular text-text-weaker">
                        {getRelativeTime(new Date(entry.timestamp).toISOString(), language.t)}
                      </span>
                    </div>

                    <div class="flex items-center gap-1 shrink-0 opacity-80 group-hover:opacity-100">
                      <Button
                        size="small"
                        variant="secondary"
                        onClick={(e: MouseEvent) => {
                          e.stopPropagation()
                          handleRestore(entry)
                        }}
                      >
                        Restore
                      </Button>
                      <IconButton
                        icon="trash"
                        size="small"
                        variant="ghost"
                        title="Delete stash"
                        onClick={(e: MouseEvent) => handleDelete(entry.id, e)}
                      />
                    </div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </div>
    </Dialog>
  )
}
