// Cross-platform Deno FFI mmap tests with bulk read/write timing

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts"

function logAlways(msg: string) {
    Deno.stdout.writeSync(new TextEncoder().encode(msg + "\n"))
}

// Fill large buffers with crypto RNG in 64 KiB chunks (getRandomValues limit).
function randomFillBig(buf: Uint8Array) {
    const max = 65536
    for (let i = 0; i < buf.length; i += max) {
        crypto.getRandomValues(buf.subarray(i, Math.min(i + max, buf.length)))
    }
    return buf
}

// Chunked byte-wise equality to avoid huge allocations inside std/assert.
function bytesEqual(a: Uint8Array, b: Uint8Array, chunk = 1 << 20 /* 1 MiB */): boolean {
    if (a.byteLength !== b.byteLength) return false
    for (let off = 0; off < a.byteLength; off += chunk) {
        const end = Math.min(off + chunk, a.byteLength)
        const sa = a.subarray(off, end)
        const sb = b.subarray(off, end)
        // Compare by 32-bit words first, then tail
        const va = new DataView(sa.buffer, sa.byteOffset, sa.byteLength)
        const vb = new DataView(sb.buffer, sb.byteOffset, sb.byteLength)
        let i = 0
        const n = (sa.byteLength / 4) | 0
        for (; i < n; i++) if (va.getUint32(i * 4, true) !== vb.getUint32(i * 4, true)) return false
        for (let k = i * 4; k < sa.byteLength; k++) if (sa[k] !== sb[k]) return false
    }
    return true
}

let libPath: string
switch (Deno.build.os) {
    case "windows":
        libPath = "./dist/windows-x86_64/mmap_ffi.dll"
        break;
    case "linux":
        libPath = "./dist/linux-x86_64/libmmap_ffi.so"
        break;
    case "darwin":
        libPath = "./dist/macos-aarch64/libmmap_ffi.dylib"
        break;
    default:
        throw new Error(`Unsupported OS: ${Deno.build.os}`)
}

const lib = Deno.dlopen(libPath, {
    mmap_open:  { parameters: ["buffer", "pointer"], result: "pointer" },
    mmap_open_write: { parameters: ["buffer", "pointer"], result: "pointer" },
    mmap_write: { parameters: ["pointer", "usize", "pointer", "usize"], result: "usize" },
    mmap_read:  { parameters: ["pointer", "pointer", "usize", "usize"], result: "usize" },
    mmap_flush: { parameters: ["pointer", "usize", "usize"], result: "i32" }, // 0 = success
    mmap_close: { parameters: ["pointer", "usize"], result: "void" },
})

function cString(str: string): Uint8Array {
    return new TextEncoder().encode(str + "\0")
}

const SIZE = 1024 * 1024 * 1024; // 1 GiB
// const SIZE = 1024 * 1024;     // 1 MiB

Deno.test("mmap write test", async () => {
    const filePath = "writefile.bin"

    const init = new Uint8Array(SIZE)
    await Deno.writeFile(filePath, init)

    const lenBuf = new BigUint64Array(1)
    const lenPtr = Deno.UnsafePointer.of(lenBuf)

    const ptr = lib.symbols.mmap_open_write(cString(Deno.cwd() + "/" + filePath), lenPtr)
    assert(ptr && Deno.UnsafePointer.value(ptr) !== 0n, "mmap_open_write failed")

    const mappedLen = Number(lenBuf[0])
    assert(mappedLen === SIZE, `mappedLen=${mappedLen} expected=${SIZE}`)

    const pattern = randomFillBig(new Uint8Array(mappedLen))
    const srcPtr  = Deno.UnsafePointer.of(pattern)

    const t0 = performance.now()
    const written = lib.symbols.mmap_write(ptr, 0n, srcPtr, BigInt(mappedLen))
    const t1 = performance.now()

    if (Number(written) !== mappedLen) {
        throw new Error(`partial write: ${written} of ${mappedLen}`)
    }
    logAlways(`Wrote ${mappedLen} bytes via mmap_write in ${(t1 - t0).toFixed(3)} ms`)

    const f0 = performance.now()
    const rc = lib.symbols.mmap_flush(ptr, 0n, BigInt(mappedLen)) // i32: 0 = success
    const f1 = performance.now()
    assert(rc === 0, "mmap_flush failed")
    logAlways(`Flush ${mappedLen} bytes in ${(f1 - f0).toFixed(3)} ms`)

    lib.symbols.mmap_close(ptr, BigInt(mappedLen))

    const disk = await Deno.readFile(filePath)
    assert(bytesEqual(disk, pattern), "content mismatch after write")
})


Deno.test("mmap read test (bulk mmap_read)", async () => {
    const filePath = "bigfile.bin"
    const data = randomFillBig(new Uint8Array(SIZE))
    await Deno.writeFile(filePath, data)

    const lenBuf = new BigUint64Array(1)
    const lenPtr = Deno.UnsafePointer.of(lenBuf)

    const ptr = lib.symbols.mmap_open(cString(Deno.cwd() + "/" + filePath), lenPtr)
    assert(ptr && Deno.UnsafePointer.value(ptr) !== 0n, "mmap_open failed")

    const mappedLen = Number(lenBuf[0])
    assert(mappedLen === SIZE, `mappedLen=${mappedLen} expected=${SIZE}`)

    const out = new Uint8Array(mappedLen)
    const outPtr = Deno.UnsafePointer.of(out)

    const t0 = performance.now()
    const got = lib.symbols.mmap_read(outPtr, ptr, 0n, BigInt(mappedLen))
    const t1 = performance.now()

    if (Number(got) !== mappedLen) {
        throw new Error(`partial read: ${got} of ${mappedLen}`)
    }
    logAlways(`Read ${mappedLen} bytes via mmap_read in ${(t1 - t0).toFixed(3)} ms`)

    assert(bytesEqual(out, data), "content mismatch after read")

    lib.symbols.mmap_close(ptr, BigInt(mappedLen))
})


