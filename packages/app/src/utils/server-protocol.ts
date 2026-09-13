import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

export type ServerProtocol = "v1" | "v2"
export type ServerCapabilities = { readonly durableSessionInput?: 1 }
export type ServerProfile = { readonly protocol: ServerProtocol; readonly capabilities: ServerCapabilities }

function headers(server: ServerConnection.HttpBase) {
  if (!server.password) return
  return {
    Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
  }
}

async function probe(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch, path: string) {
  const response = await fetch(new URL(path, server.url), {
    headers: headers(server),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return
  const value: unknown = await response.json()
  if (!value || typeof value !== "object") return
  return value
}

function durableSessionInputCapabilities(value: object): ServerCapabilities {
  if (!("capabilities" in value) || !value.capabilities || typeof value.capabilities !== "object") return {}
  const capabilities = value.capabilities
  if (!("durableSessionInput" in capabilities) || capabilities.durableSessionInput !== 1) return {}
  return { durableSessionInput: 1 }
}

export async function detectServerProfile(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
): Promise<ServerProfile> {
  const legacy = await probe(server, fetch, "/global/health").catch(() => undefined)
  if (legacy && "healthy" in legacy && legacy.healthy === true)
    return { protocol: "v1", capabilities: durableSessionInputCapabilities(legacy) }

  const current = await probe(server, fetch, "/api/health").catch(() => undefined)
  if (current && "pid" in current && typeof current.pid === "number") return { protocol: "v2", capabilities: {} }
  if (current && "healthy" in current && current.healthy === true) return { protocol: "v1", capabilities: {} }
  return { protocol: "v2", capabilities: {} }
}

export async function detectServerProtocol(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
): Promise<ServerProtocol> {
  return (await detectServerProfile(server, fetch)).protocol
}
