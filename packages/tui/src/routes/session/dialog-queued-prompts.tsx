import { createMemo, onMount } from "solid-js"
import type { SessionInputPending } from "@opencode-ai/sdk/v2"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useDialog } from "../../ui/dialog"
import { Locale } from "../../util/locale"

export function queuedPromptOptions(inputs: readonly SessionInputPending[]): DialogSelectOption<string>[] {
  return inputs.map((input) => ({
    value: input.id,
    title: input.prompt.text.replace(/\n/g, " ") || "[attachment]",
    footer: `#${input.admittedSeq} · ${Locale.time(input.timeCreated)}`,
  }))
}

export function DialogQueuedPrompts(props: { inputs: readonly SessionInputPending[] }) {
  const dialog = useDialog()
  onMount(() => dialog.setSize("large"))

  const options = createMemo(() => queuedPromptOptions(props.inputs))

  return <DialogSelect title="Queued prompts" options={options()} />
}
