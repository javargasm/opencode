import type {
  AgentPartInput,
  FilePartInput,
  PromptInput,
  SessionInputPending,
  TextPartInput,
} from "@opencode-ai/sdk/v2"

export type LegacyPromptPart = TextPartInput | FilePartInput | AgentPartInput

/** Converts the serializable composer parts into the durable V2 input shape. */
export function toDurablePromptInput(parts: readonly LegacyPromptPart[]): PromptInput {
  const files = parts.flatMap((part) => {
    if (part.type !== "file") return []
    return [{ uri: part.url, ...(part.filename === undefined ? {} : { name: part.filename }) }]
  })
  const agents = parts.flatMap((part) => (part.type === "agent" ? [{ name: part.name }] : []))
  return {
    text: parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    ...(files.length === 0 ? {} : { files }),
    ...(agents.length === 0 ? {} : { agents }),
  }
}

export type DurableSessionClient = {
  v2: {
    session: {
      prompt(input: {
        sessionID: string
        id: string
        prompt: PromptInput
        delivery: "queue"
        resume: boolean
      }): Promise<unknown>
      pendingInputs(input: { sessionID: string }): Promise<{ data?: { data?: SessionInputPending[] } }>
    }
  }
}

export async function admitQueue(
  client: DurableSessionClient,
  input: { sessionID: string; id: string; prompt: PromptInput },
) {
  await client.v2.session.prompt({ ...input, delivery: "queue", resume: false })
}

export async function pendingInputs(client: DurableSessionClient, sessionID: string) {
  return (await client.v2.session.pendingInputs({ sessionID })).data?.data ?? []
}
