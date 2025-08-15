// Generate checksums.json mapping: "<asset-file>" -> "<sha256 hex>"
// Usage:
//   deno run --allow-read --allow-write scripts/gen_checksums_json.ts [inDir=dist] [outFile=checksums.json]
//   deno run -A scripts/gen_checksums_json.ts artifacts checksums.json --verbose --strict
//
// Options (flags):
//   --name-regex=<regex>   Override asset filename regex
//   --dry-run              Print JSON to stdout, do not write file
//   --pretty               Pretty-print JSON (default true when writing to file)
//   --strict               Fail on duplicate asset basenames (e.g., found in multiple subdirs)
//   --fail-on-empty        Fail if no matching assets found
//   --verbose              Verbose logging
//
// Expected asset filenames (default regex):
//   deno_mmapio_ffi-windows-x86_64.dll
//   deno_mmapio_ffi-linux-x86_64.so
//   deno_mmapio_ffi-macos-aarch64.dylib
//
// Exit codes:
//   0 = success, non-zero = error (invalid args, I/O error, checksum/duplicates violation, etc.)

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts"
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts"
import { dirname } from "https://deno.land/std@0.224.0/path/mod.ts"

const DEFAULT_REGEX = /^deno_mmapio_ffi-(windows|linux|macos)-(x86_64|aarch64)\.(dll|so|dylib)$/

const argv = parse(Deno.args, {
  boolean: ["dry-run", "pretty", "strict", "fail-on-empty", "verbose"],
  string: ["name-regex"],
  alias: {
    d: "dry-run",
    p: "pretty",
    s: "strict",
    v: "verbose",
  },
})

const inDir = (argv._[0]?.toString() ?? "dist").replace(/[/\\]+$/, "")
const outFile = (argv._[1]?.toString() ?? "checksums.json").trim()
const verbose = !!argv["verbose"]
const strict = !!argv["strict"]
const failOnEmpty = !!argv["fail-on-empty"]
const dryRun = !!argv["dry-run"]

// pretty default: if writing to file -> true; if dry-run to CI logs -> false by default
const pretty: boolean = argv.pretty === undefined ? !dryRun : Boolean(argv.pretty)

const nameRegex = new RegExp(argv["name-regex"] ? String(argv["name-regex"]) : DEFAULT_REGEX)

if (verbose) {
  console.error(
    `[gen_checksums_json] inDir="${inDir}", outFile="${outFile}", dryRun=${dryRun}, pretty=${pretty}, strict=${strict}, failOnEmpty=${failOnEmpty}`,
  )
  console.error(`[gen_checksums_json] nameRegex=${nameRegex}`)
}

// Compute SHA-256 as lowercase hex
async function sha256Hex(u8: Uint8Array): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", u8)
  const b = new Uint8Array(dig)
  // Lowercase hex
  let s = ""
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0")
  return s
}

type MapType = Record<string, string>

// Walk input dir recursively and collect matching files by BASENAME
async function collect(inDirPath: string): Promise<MapType> {
  const map: MapType = Object.create(null)
  const seenPaths: Record<string, string> = Object.create(null)

  let countVisited = 0
  let countMatched = 0

  for await (const e of walk(inDirPath, { includeFiles: true, followSymlinks: false })) {
    if (!e.isFile) continue
    countVisited++

    const base = e.name // basename
    if (!nameRegex.test(base)) {
      if (verbose && countVisited <= 10) {
        // Avoid flooding logs: show first few skips
        console.error(`[skip] ${e.path}`)
      }
      continue
    }

    // Duplicate detection: same basename encountered twice
    if (seenPaths[base] && seenPaths[base] !== e.path) {
      const msg = `Duplicate asset basename "${base}" at:\n  - ${seenPaths[base]}\n  - ${e.path}`
      if (strict) {
        throw new Error(msg)
      } else if (verbose) {
        console.error(`[warn] ${msg}\n  -> last one wins (non-strict mode)`)
      }
    }

    const data = await Deno.readFile(e.path)
    const hash = await sha256Hex(data)
    map[base] = hash
    seenPaths[base] = e.path
    countMatched++
    if (verbose) console.error(`[ok] ${base} sha256=${hash}`)
  }

  if (verbose) {
    console.error(`[gen_checksums_json] visited=${countVisited}, matched=${countMatched}`)
  }

  if (failOnEmpty && countMatched === 0) {
    throw new Error(`No matching assets found in "${inDirPath}" (regex=${nameRegex})`)
  }

  return map
}

// Write JSON with sorted keys for stable diffs
async function writeJson(filePath: string, map: MapType, prettyPrint: boolean): Promise<string> {
  const keys = Object.keys(map).sort()
  const out: MapType = {}
  for (const k of keys) out[k] = map[k]

  const json = prettyPrint ? JSON.stringify(out, null, 2) + "\n" : JSON.stringify(out)

  if (!dryRun) {
    // Ensure directory exists
    const dir = dirname(filePath)
    if (dir && dir !== "." && dir !== "") {
      await Deno.mkdir(dir, { recursive: true }).catch(() => {})
    }
    await Deno.writeTextFile(filePath, json)
  }
  return json
}

try {
  const mapping = await collect(inDir)
  const json = await writeJson(outFile, mapping, pretty)

  if (dryRun) {
    console.log(json)
  } else {
    console.error(
      `[gen_checksums_json] Wrote ${outFile} with ${Object.keys(mapping).length} entr${Object.keys(mapping).length === 1 ? "y" : "ies"}`,
    )
  }
// deno-lint-ignore no-explicit-any
} catch (err: any) {
  console.error(`[gen_checksums_json] ERROR: ${err?.message ?? err}`)
  Deno.exit(1)
}
