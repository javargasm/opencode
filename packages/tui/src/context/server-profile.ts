export type ServerProtocol = "v1" | "v2"
export type ServerCapabilities = { readonly durableSessionInput?: 1 }
export type ServerProfile = { readonly protocol: ServerProtocol; readonly capabilities: ServerCapabilities }

function asHeaders(headers: RequestInit["headers"]) {
  if (!headers) return undefined
  return new Headers(headers)
}

async function probe(input: { url: string; fetch: typeof globalThis.fetch; headers?: RequestInit["headers"] }, path: string) {
  const response = await input.fetch(new URL(path, input.url), {
    headers: asHeaders(input.headers),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return
  const value: unknown = await response.json()
  if (!value || typeof value !== "object") return
  return value
}

function capabilities(value: object): ServerCapabilities {
  if (!("capabilities" in value) || !value.capabilities || typeof value.capabilities !== "object") return {}
  const raw = value.capabilities
  if (!("durableSessionInput" in raw) || raw.durableSessionInput !== 1) return {}
  return { durableSessionInput: 1 }
}

/**
 * Detects the additive durable-input capability without ever reclassifying a
 * V1 server as V2. An unreachable or malformed health endpoint stays on the
 * conservative V2 profile so a native V2 server remains usable.
 */
export async function detectServerProfile(input: {
  url: string
  fetch: typeof globalThis.fetch
  headers?: RequestInit["headers"]
}): Promise<ServerProfile> {
  const legacy = await probe(input, "/global/health").catch(() => undefined)
  if (legacy && "healthy" in legacy && legacy.healthy === true)
    return { protocol: "v1", capabilities: capabilities(legacy) }

  const current = await probe(input, "/api/health").catch(() => undefined)
  if (current && "pid" in current && typeof current.pid === "number") return { protocol: "v2", capabilities: {} }
  if (current && "healthy" in current && current.healthy === true) return { protocol: "v1", capabilities: {} }
  return { protocol: "v2", capabilities: {} }
}

export function supportsDurableSessionInput(profile: ServerProfile) {
  return profile.protocol === "v2" || profile.capabilities.durableSessionInput === 1
}
