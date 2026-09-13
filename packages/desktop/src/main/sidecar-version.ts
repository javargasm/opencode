import type { CHANNEL } from "./constants"

export type SidecarVersion = "v1" | "v2"

export function resolveSidecarVersion(
  channel: typeof CHANNEL,
  sourceCliBundled: boolean,
  override: string | undefined,
): SidecarVersion {
  if (override === "0") return "v1"
  if (override === "1") return "v2"
  return channel === "dev" || sourceCliBundled ? "v2" : "v1"
}
