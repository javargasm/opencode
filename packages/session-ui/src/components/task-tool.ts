export function taskRunning(status: string | undefined, background: boolean, childStatus: string | undefined) {
  return status === "pending" || status === "running" || (background && childStatus !== undefined && childStatus !== "idle")
}
