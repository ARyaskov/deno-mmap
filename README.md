# Deno mmap

> High-performance memory-mapped file I/O for **Deno/Typescript** via FFI (Rust backend).
> Zero-overhead mapping, bulk read/write in a single native call, cross-platform binaries auto-downloaded from GitHub Releases with SHA-256 verification.
> 
> Works on **Windows x86\_64**, **Linux x86\_64**, **macOS aarch64** (Apple Silicon).
> Requires Deno **2.x** with FFI permissions.

---

## Install

```ts
import {
  open,
  openWrite,
  openWriteWithSize,
  read,
  write,
  flush,
  close,
  type MmapHandle,
} from "jsr:@riaskov/mmap";
```

### Required permissions

This package loads a native library and (on first use) may download it from GitHub Releases and cache it locally.

* Run your program with:

  ```
  --allow-ffi --unstable-ffi --allow-read --allow-write --allow-net
  ```

    * `--allow-net` is only needed for the first run (download).
    * After the library is cached, you can omit `--allow-net`.

### Environment overrides

* `MMAP_LIB_PATH`: absolute path to a local binary to load instead of downloading.
  Useful in CI or when testing locally built artifacts.

---

## API

All offsets/lengths that cross the FFI boundary use **`bigint`** (Deno FFI maps `usize`/`size_t` to `bigint`). The high-level wrappers do the conversions for you.

```ts
type MmapHandle = {
  ptr: Deno.PointerValue; // native pointer to the mapped region
  len: number;            // mapped length in bytes
  path: string;           // absolute path used to open the mapping
};
```

### `open(path: string): Promise<MmapHandle>`

Map an existing file **read-only** (native `mmap_open`).
Throws if the file doesn’t exist.

### `openWrite(path: string): Promise<MmapHandle>`

Map an existing file **read-write** (native `mmap_open_write`).
Length equals the current file size. The file must already exist.

### `openWriteWithSize(path: string, size: number | bigint): Promise<MmapHandle>`

Map for write ensuring the file size is at least `size`.

* If the native symbol exists, it resizes atomically in Rust (Windows: `SetFilePointerEx+SetEndOfFile`; Unix: `ftruncate`).
* If not, the wrapper falls back to `Deno.truncate(path, size)` and then `openWrite`.

### `write(h: MmapHandle, src: Uint8Array, offset = 0n): Promise<number>`

Copy `src` into the mapped region at `offset` (single native `memcpy`).
Returns number of bytes written. Throws if the write would exceed `h.len`.

### `read(h: MmapHandle, dst: Uint8Array, offset = 0n): Promise<number>`

Copy from the mapped region at `offset` into `dst` (single native `memcpy`).
Returns number of bytes read. Throws if the read would exceed `h.len`.

### `flush(h: MmapHandle, offset = 0n, length?: number | bigint): Promise<void>`

Synchronize modified pages with the file (Unix: `msync(MS_SYNC)`, Windows: `FlushViewOfFile`).

> Note: This ensures OS write-back of the view. If you need an additional **device durability** guarantee on Windows, you may also require `FlushFileBuffers` on the file handle (planned optional API).

### `close(h: MmapHandle): Promise<void>`

Unmap the region and release native resources.

---

## Usage

### Read whole file into a JS buffer

```ts
const h = await open("data.bin")
const buf = new Uint8Array(h.len)

console.time("mmap_read")
await read(h, buf)                 // bulk memcpy from mapping into buf
console.timeEnd("mmap_read")

await close(h)
```

### Create/resize and write, then flush

```ts
const outPath = "out.bin"
const SIZE = 1024 * 1024 * 1024; // 1 GiB

const hw = await openWriteWithSize(outPath, SIZE)
const chunk = crypto.getRandomValues(new Uint8Array(65000))

console.time("mmap_write")
for (let off = 0n; off < BigInt(hw.len); off += BigInt(chunk.length)) {
  await write(hw, chunk, off)
}
console.timeEnd("mmap_write")

console.time("mmap_flush")
await flush(hw); // flush entire region
console.timeEnd("mmap_flush")

await close(hw)
```

### Random access (read at offset/len)

```ts
// Read a slice [offset, offset+len) directly into your buffer.
const file = await open("big.bin")
const offset = 128n * 1024n * 1024n // 128 MiB
const len = 64 * 1024               // 64 KiB
const window = new Uint8Array(len)

await read(file, window, offset)

// ...use `window`...

await close(file)
```

---

## Performance notes

* `read`/`write` are single native **`memcpy`** calls across the FFI boundary → typically **GB/s** throughput (memory-bound).
* `flush` measures the **price of synchronizing to disk** and depends on filesystem, antivirus, encryption, etc. Expect much lower throughput vs memcpy.
* For true cold-cache disk benchmarks, mmap is usually not the right tool (the OS page cache will help); use unbuffered I/O if you need that.

---

## Platform support & assets

The loader resolves the correct asset name for your platform and verifies it against a bundled `checksums.json`:

| OS      | Arch    | Asset file name                |
| ------- | ------- |--------------------------------|
| Windows | x86\_64 | `mmap_ffi-windows-x86_64.dll`  |
| Linux   | x86\_64 | `mmap_ffi-linux-x86_64.so`     |
| macOS   | aarch64 | `mmap_ffi-macos-aarch64.dylib` |

> Dev mode: if `./dist/<asset>` exists, the loader uses it.
> Override: set `MMAP_LIB_PATH` to a specific binary.

**Windows paths:** current native implementation uses ANSI (`CreateFileA`). Prefer ASCII-safe paths. A `CreateFileW`/UTF-16 upgrade is planned.

---

## Security & integrity

* First run downloads the binary from **GitHub Releases** for the tagged version and stores it in a user cache directory.
* The loader validates the binary via **SHA-256** from `checksums.json`.
  On mismatch the file is rejected.

---

## Testing

The repository includes benchmarks and correctness tests similar to:

```bash
deno test --allow-ffi --unstable-ffi --allow-read --allow-write
```

---

## Development

### Build native binaries locally (Windows PowerShell)

```powershell
pwsh -File scripts/build-release.ps1 `
  -CrateDir ffi `
  -CrateName mmap_ffi `
  -Targets @("x86_64-pc-windows-msvc") `
  -Configuration release
```

* Artifacts are copied and **renamed** into `dist/` as flat files (see table above).
* The script also generates `dist/checksums.txt` and `dist/checksums.json`.

### Generate `checksums.json` (alternative)

```bash
deno task gen:checksums
# or: deno run --allow-read --allow-write scripts/gen_checksums_json.ts dist checksums.json
```

### Format TS sources with Prettier

```bash
# once:
deno run -A npm:prettier --write "src/**/*.{ts,tsx,js,jsx,json,md}"

# tasks (add in deno.json):
deno task fmt
deno task fmt:check
```

### Release pipeline (GitHub Actions)

* Push a tag `vX.Y.Z` → CI builds platform binaries, creates a GitHub Release, generates `checksums.json`, and **publishes to JSR via OIDC** (no token needed) once the repo is linked in JSR package settings.

---

## Troubleshooting

**Permission errors (Deno flags):**

* Make sure you run with:
  `--allow-ffi --unstable-ffi --allow-read --allow-write`
* On first run (downloading from GitHub): also `--allow-net`.

**“The specified procedure could not be found” / “Failed to register symbol …”:**

* The DLL/SO/DYLIB doesn’t export a symbol your loader expects.

    * Ensure the native and TypeScript layers are from **the same version**.
    * If you updated the Rust API (e.g. added `mmap_open_write_with_size`), either ship updated binaries or let the TS wrapper use the built-in fallback.

**Checksum mismatch:**

* You replaced a binary in `dist/` (or in cache) but didn’t update `checksums.json`.

    * Re-generate checksums: `deno task gen:checksums` (or your CI will do it from artifacts).
    * Or override loader via `MMAP_LIB_PATH`.

**Corporate proxy / offline environments:**

* Pre-bundle binaries in your image and set `MMAP_LIB_PATH` to skip download.
* Alternatively, seed the cache directory with the verified file (same path the loader uses).

**Unsupported OS/arch:**

* Currently supported: Windows x86\_64, Linux x86\_64, macOS aarch64.
* To add more (e.g., macOS x86\_64), build and attach an extra artifact and extend the loader’s `platform.ts`.

**Windows Unicode paths:**

* Current implementation uses ANSI (`CreateFileA`), so prefer ASCII-safe paths.
* If you need full Unicode support, wait for (or contribute) `CreateFileW` support; the TS wrapper will not change.

**JSR publish (OIDC) fails:**

* Ensure your JSR package is **linked to the GitHub repo** in JSR settings.
* The GitHub Actions job must have `permissions: id-token: write`.
* Tag (`vX.Y.Z`) **must match** `deno.json` version.

---

## License

MIT — see [LICENSE](./LICENSE).
