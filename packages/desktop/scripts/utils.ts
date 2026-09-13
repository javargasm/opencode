import { $ } from "bun"
import { chmod, copyFile } from "node:fs/promises"
import { join } from "node:path"

export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = Bun.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}

export const CLI_TARGETS: Array<{ rustTarget: string; output: string; os: string }> = [
  {
    rustTarget: "aarch64-apple-darwin",
    output: "cli-darwin-arm64",
    os: "darwin",
  },
  {
    rustTarget: "x86_64-apple-darwin",
    output: "cli-darwin-x64-baseline",
    os: "darwin",
  },
  {
    rustTarget: "aarch64-pc-windows-msvc",
    output: "cli-windows-arm64",
    os: "win32",
  },
  {
    rustTarget: "x86_64-pc-windows-msvc",
    output: "cli-windows-x64-baseline",
    os: "win32",
  },
  {
    rustTarget: "x86_64-unknown-linux-gnu",
    output: "cli-linux-x64-baseline",
    os: "linux",
  },
  {
    rustTarget: "aarch64-unknown-linux-gnu",
    output: "cli-linux-arm64",
    os: "linux",
  },
]

export const RUST_TARGET = Bun.env.RUST_TARGET

function nativeTarget() {
  const { platform, arch } = process
  if (platform === "darwin") return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
  if (platform === "win32") return arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"
  if (platform === "linux") return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

export function getCurrentCli(target = RUST_TARGET ?? nativeTarget()) {
  const binaryConfig = CLI_TARGETS.find((item) => item.rustTarget === target)
  if (!binaryConfig) throw new Error(`CLI source build target is not available for '${target}'`)

  return binaryConfig
}

export function shouldBundleSourceCli(channel = resolveChannel()) {
  return channel === "dev" || Bun.env.OPENCODE_BUNDLE_SOURCE_CLI === "1"
}

export async function buildSourceCliToResources() {
  const cli = getCurrentCli()
  const cliDirectory = join(import.meta.dir, "../../cli")
  const destination = windowsify(join(import.meta.dir, "../resources/opencode-cli"), cli.os)
  const source = join(cliDirectory, "dist", cli.output, "bin", cli.os === "win32" ? "lildax.exe" : "lildax")
  const prebuiltSource = Bun.env.OPENCODE_SOURCE_CLI_PATH

  if (prebuiltSource) {
    await copyFile(prebuiltSource, destination)
  } else {
    // A native checkout already has the required platform module. Cross-arch
    // Electron release builds need build.ts to install the target runtime.
    if (cli.rustTarget === nativeTarget()) {
      await $`bun script/build.ts --single --skip-install --target=${cli.output}`.cwd(cliDirectory)
    } else {
      await $`bun script/build.ts --single --target=${cli.output}`.cwd(cliDirectory)
    }
    await copyFile(source, destination)
  }

  if (cli.os !== "win32") await chmod(destination, 0o755)
  if (cli.os === "win32" && process.platform === "win32" && process.env.GITHUB_ACTIONS === "true") {
    const dest = destination
    await $`pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File ../../script/sign-windows.ps1 ${dest}`
  }
  if (cli.os === "darwin" && process.platform === "darwin") await $`codesign --force --sign - ${destination}`

  console.log(`${prebuiltSource ? "Copied" : "Built"} ${cli.output} source CLI to ${destination}`)
}

export function windowsify(path: string, targetOs = process.platform) {
  if (path.endsWith(".exe")) return path
  return `${path}${targetOs === "win32" ? ".exe" : ""}`
}
