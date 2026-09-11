import { createSimpleContext } from "@opencode-ai/ui/context"
import { createStore, produce, unwrap } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import type { ContentPart } from "./prompt-state"

export type StashEntry = {
  id: string
  input: string
  parts: ContentPart[]
  timestamp: number
}

export const MAX_STASH_ENTRIES = 50

export function hasStashablePrompt(parts: ContentPart[]) {
  return parts.some((part) => {
    if (part.type !== "text") return true
    return part.content.trim().length > 0
  })
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  gate: false,
  init: () => {
    const [store, setStore, _, ready] = persisted(
      Persist.prompt(Persist.global("prompt.stash")),
      createStore({ entries: [] as StashEntry[] }),
    )

    return {
      ready,
      list() {
        return store.entries
      },
      push(entry: { input: string; parts?: ContentPart[] }) {
        const id = Math.random().toString(36).slice(2, 9)
        const stash: StashEntry = {
          id,
          input: entry.input,
          parts: entry.parts ? structuredClone(unwrap(entry.parts)) : [],
          timestamp: Date.now(),
        }

        setStore(
          produce((draft) => {
            draft.entries.unshift(stash)
            if (draft.entries.length > MAX_STASH_ENTRIES) {
              draft.entries = draft.entries.slice(0, MAX_STASH_ENTRIES)
            }
          }),
        )
        return stash
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[0]
        setStore(produce((draft) => void draft.entries.shift()))
        return entry
      },
      remove(id: string) {
        setStore(
          produce((draft) => {
            const index = draft.entries.findIndex((e) => e.id === id)
            if (index >= 0) draft.entries.splice(index, 1)
          }),
        )
      },
      clear() {
        setStore("entries", [])
      },
    }
  },
})
