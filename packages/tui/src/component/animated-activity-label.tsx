import type { ColorInput, RGBA } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { sessionActivityLabel, type SessionActivity } from "../util/session"
import { createColors, createFrameCount } from "../ui/spinner"

export function ActiveDescendantLabel(props: {
  activity: SessionActivity
  activeDescendantCount: number
  color: RGBA
  mutedColor: RGBA
  animated: boolean
}) {
  return (
    <Show when={sessionActivityLabel(props.activity, props.activeDescendantCount)}>
      {(label) => (
        <AnimatedActivityLabel
          label={label()}
          color={props.color}
          mutedColor={props.mutedColor}
          animated={props.animated}
        />
      )}
    </Show>
  )
}

export function AnimatedActivityLabel(props: { label: string; color: RGBA; mutedColor: RGBA; animated: boolean }) {
  return (
    <text fg={props.mutedColor}>
      <AnimatedText label={props.label} color={props.color} animated={props.animated} />
    </text>
  )
}

export function AnimatedText(props: { label: string; color: ColorInput; animated: boolean }) {
  const characters = createMemo(() => Array.from(props.label))
  const options = createMemo(() => ({
    color: props.color,
    inactiveFactor: 0.6,
    minAlpha: 0.3,
  }))
  const totalFrames = createMemo(() => createFrameCount({ width: characters().length }))
  const colors = createMemo(() => createColors(options()))
  const [frame, setFrame] = createSignal(0)

  createEffect(() => {
    if (!props.animated) {
      setFrame(0)
      return
    }

    const timer = setInterval(() => setFrame((value) => (value + 1) % totalFrames()), 40)
    timer.unref?.()
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={props.animated} fallback={props.label}>
      <For each={characters()}>
        {(character, index) => (
          <span style={{ fg: colors()(frame(), index(), totalFrames(), characters().length) }}>{character}</span>
        )}
      </For>
    </Show>
  )
}
