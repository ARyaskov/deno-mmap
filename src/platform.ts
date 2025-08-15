export type Os = "windows" | "linux" | "darwin"
export type Arch = "x86_64" | "aarch64"

export function currentPlatform(): { os: Os; arch: Arch } {
  const os = Deno.build.os as Os
  if (os !== "windows" && os !== "linux" && os !== "darwin") throw new Error(`Unsupported OS: ${os}`)
  let arch: Arch
  switch (Deno.build.arch) {
    case "x86_64":
      arch = "x86_64"
      break
    case "aarch64":
      arch = "aarch64"
      break
    default:
      throw new Error(`Unsupported arch: ${Deno.build.arch}`)
  }
  return { os, arch }
}

export function assetName(crateName = "mmap_ffi"): string {
  const { os, arch } = currentPlatform()
  const ext = os === "windows" ? "dll" : os === "linux" ? "so" : "dylib"
  const osTag = os === "darwin" ? "macos" : os
  return `${crateName}-${osTag}-${arch}.${ext}`
}
