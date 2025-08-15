// Resolves platform asset, loads native library with fallback symbol sets,
// downloads from GitHub Releases if not present locally, and verifies SHA-256.

import pkg from "../deno.json" with { type: "json" }
import checksums from "../checksums.json" with { type: "json" }
import { assetName, currentPlatform } from "./platform.ts"

const OWNER = "ARyaskov"
const REPO = "deno-mmap"
const VERSION = pkg.version as string

export type SymbolsV2 = {
  mmap_open: (p: Uint8Array, len: Deno.PointerValue) => Deno.PointerValue | null
  mmap_open_write: (p: Uint8Array, len: Deno.PointerValue) => Deno.PointerValue | null
  mmap_open_write_with_size?: (p: Uint8Array, len: Deno.PointerValue, size: bigint) => Deno.PointerValue | null
  mmap_write: (dst: Deno.PointerValue, off: bigint, src: Deno.PointerValue, len: bigint) => bigint
  mmap_read: (dst: Deno.PointerValue, base: Deno.PointerValue, off: bigint, len: bigint) => bigint
  mmap_flush: (base: Deno.PointerValue, off: bigint, len: bigint) => number // 0 = success
  mmap_close: (base: Deno.PointerValue, len: bigint) => void
}

export type Loaded = ReturnType<typeof Deno.dlopen>

function cstr(s: string) {
  return new TextEncoder().encode(s + "\0")
}
export function toCStringPath(path: string) {
  return cstr(path)
}

function cacheDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? Deno.cwd()
  const { os } = currentPlatform()
  if (os === "windows") {
    const base = Deno.env.get("LOCALAPPDATA") ?? home
    return `${base}\\mmap\\cache\\${VERSION}`
  } else if (os === "darwin") {
    return `${home}/Library/Caches/mmap/${VERSION}`
  } else {
    const base = Deno.env.get("XDG_CACHE_HOME") ?? `${home}/.cache`
    return `${base}/mmap/${VERSION}`
  }
}

async function ensureDir(p: string) {
  try {
    await Deno.mkdir(p, { recursive: true })
  } catch {
    /* ignore */
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", bytes)
  const u = new Uint8Array(dig)
  return Array.from(u)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function devPath(asset: string): string | null {
  const { os, arch } = currentPlatform()
  const osTag = os === "darwin" ? "macos" : os
  const p = `./dist/${asset}`
  try {
    const st = Deno.statSync(p)
    if (st.isFile) return p
  } catch {}
  // legacy dev path:
  const legacy = `./dist/${osTag}-${arch}/${asset}`
  try {
    const st = Deno.statSync(legacy)
    if (st.isFile) return legacy
  } catch {}
  return null
}

async function downloadAsset(asset: string): Promise<Uint8Array> {
  const url = `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/${asset}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status} ${r.statusText}`)
  const ab = await r.arrayBuffer()
  return new Uint8Array(ab)
}

const symbolsV2 = {
  mmap_open: { parameters: ["buffer", "pointer"], result: "pointer" },
  mmap_open_write: { parameters: ["buffer", "pointer"], result: "pointer" },
  mmap_open_write_with_size: { parameters: ["buffer", "pointer", "usize"], result: "pointer" },
  mmap_write: { parameters: ["pointer", "usize", "pointer", "usize"], result: "usize" },
  mmap_read: { parameters: ["pointer", "pointer", "usize", "usize"], result: "usize" },
  mmap_flush: { parameters: ["pointer", "usize", "usize"], result: "i32" },
  mmap_close: { parameters: ["pointer", "usize"], result: "void" },
} as const

const symbolsV1 = {
  mmap_open: { parameters: ["buffer", "pointer"], result: "pointer" },
  mmap_open_write: { parameters: ["buffer", "pointer"], result: "pointer" },
  mmap_write: { parameters: ["pointer", "usize", "pointer", "usize"], result: "usize" },
  mmap_read: { parameters: ["pointer", "pointer", "usize", "usize"], result: "usize" },
  mmap_flush: { parameters: ["pointer", "usize", "usize"], result: "i32" },
  mmap_close: { parameters: ["pointer", "usize"], result: "void" },
} as const

export async function loadLibrary(): Promise<Loaded & { symbols: SymbolsV2 }> {
  const envOverride = Deno.env.get("MMAP_LIB_PATH")
  const asset = assetName("mmap_ffi")

  let libPath: string | null = null

  if (envOverride) {
    libPath = envOverride
  } else {
    const dev = devPath(asset)
    if (dev) libPath = dev
  }

  if (!libPath) {
    const cacheRoot = cacheDir()
    await ensureDir(cacheRoot)
    const candidate = `${cacheRoot}/${asset}`
    try {
      const cached = await Deno.readFile(candidate)
      const want = (checksums as Record<string, string>)[asset]
      if (!want) throw new Error(`No checksum for ${asset}`)
      const got = await sha256Hex(cached)
      if (got.toLowerCase() !== want.toLowerCase()) throw new Error("checksum mismatch (cache)")
      libPath = candidate
    } catch {
      const bin = await downloadAsset(asset)
      const want = (checksums as Record<string, string>)[asset]
      if (!want) throw new Error(`No checksum for ${asset}`)
      const got = await sha256Hex(bin)
      if (got.toLowerCase() !== want.toLowerCase()) throw new Error(`Checksum mismatch for ${asset}`)
      await Deno.writeFile(candidate, bin, { mode: 0o755 })
      libPath = candidate
    }
  }

  // Try loading with V2 (has mmap_open_write_with_size); fall back to V1.
  try {
    return Deno.dlopen(libPath!, symbolsV2) as any
  } catch {
    return Deno.dlopen(libPath!, symbolsV1) as any
  }
}
