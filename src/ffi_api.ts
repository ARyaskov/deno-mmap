// High-level wrapper with optional openWriteWithSize fallback.

import { loadLibrary, toCStringPath } from "./loader.ts"

type Lib = Awaited<ReturnType<typeof loadLibrary>>

let libP: Promise<Lib> | null = null
function getLib() {
  return (libP ??= loadLibrary())
}

export type MmapHandle = {
  ptr: Deno.PointerValue
  len: number
  path: string
}

function ptrValue(p: Deno.PointerValue | null): bigint {
  return p ? Deno.UnsafePointer.value(p) : 0n
}

export async function open(path: string): Promise<MmapHandle> {
  const lib = await getLib()
  const lenBuf = new BigUint64Array(1)
  const lenPtr = Deno.UnsafePointer.of(lenBuf)
  const p = lib.symbols.mmap_open(toCStringPath(path), lenPtr)
  if (!p || ptrValue(p) === 0n) throw new Error(`mmap_open failed: ${path}`)
  return { ptr: p, len: Number(lenBuf[0]), path }
}

export async function openWrite(path: string): Promise<MmapHandle> {
  const lib = await getLib()
  const lenBuf = new BigUint64Array(1)
  const lenPtr = Deno.UnsafePointer.of(lenBuf)
  const p = lib.symbols.mmap_open_write(toCStringPath(path), lenPtr)
  if (!p || ptrValue(p) === 0n) throw new Error(`mmap_open_write failed: ${path}`)
  return { ptr: p, len: Number(lenBuf[0]), path }
}

/** Open for write ensuring file size >= `size`. If the native symbol is missing, fallback to Deno.truncate then openWrite. */
export async function openWriteWithSize(path: string, size: number | bigint): Promise<MmapHandle> {
  const lib = await getLib()
  const want = BigInt(size)
  // Try native if available
  const hasNative = (lib.symbols as any).mmap_open_write_with_size?.parameters
  if (hasNative) {
    const lenBuf = new BigUint64Array(1)
    const lenPtr = Deno.UnsafePointer.of(lenBuf)
    const p = (lib.symbols as any).mmap_open_write_with_size(toCStringPath(path), lenPtr, want) as Deno.PointerValue | null
    if (!p || ptrValue(p) === 0n) throw new Error(`mmap_open_write_with_size failed: ${path}`)
    return { ptr: p, len: Number(lenBuf[0]), path }
  }
  // Fallback: resize via Deno then openWrite
  await Deno.truncate(path, Number(want))
  return openWrite(path)
}

export async function write(h: MmapHandle, src: Uint8Array, offset = 0n): Promise<number> {
  const lib = await getLib()
  if (Number(offset) + src.length > h.len) throw new Error("write beyond mapping length")
  const srcPtr = Deno.UnsafePointer.of(src)
  const n = lib.symbols.mmap_write(h.ptr, offset, srcPtr, BigInt(src.length))
  return Number(n)
}

export async function read(h: MmapHandle, dst: Uint8Array, offset = 0n): Promise<number> {
  const lib = await getLib()
  if (Number(offset) + dst.length > h.len) throw new Error("read beyond mapping length")
  const dstPtr = Deno.UnsafePointer.of(dst)
  const n = lib.symbols.mmap_read(dstPtr, h.ptr, offset, BigInt(dst.length))
  return Number(n)
}

export async function flush(h: MmapHandle, offset = 0n, length?: number | bigint): Promise<void> {
  const lib = await getLib()
  const len = BigInt(length ?? h.len - Number(offset))
  const rc = lib.symbols.mmap_flush(h.ptr, offset, len)
  if (rc !== 0) throw new Error("mmap_flush failed")
}

export async function close(h: MmapHandle): Promise<void> {
  const lib = await getLib()
  lib.symbols.mmap_close(h.ptr, BigInt(h.len))
}
