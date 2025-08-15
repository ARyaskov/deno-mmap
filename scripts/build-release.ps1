<#  build-release.ps1
    Local build and packaging of native FFI binaries for the deno-mmap package.

    What it does:
      - cargo build (release/debug) for given target triples
      - copies and RENAMES artifacts into dist/ with a flat layout:
          mmap_ffi-windows-x86_64.dll
          mmap_ffi-linux-x86_64.so
          mmap_ffi-macos-aarch64.dylib
      - generates dist/checksums.txt and checksums.json (sha256, lowercase)

    Examples:
      pwsh -File scripts/build-release.ps1
      pwsh -File scripts/build-release.ps1 -Targets @("x86_64-pc-windows-msvc","x86_64-unknown-linux-gnu")
      pwsh -File scripts/build-release.ps1 -CrateDir ffi -CrateName mmap_ffi -Features "windows,linux"
#>

[CmdletBinding()]
param(
  # Path to the cdylib crate containing Cargo.toml
  [string]$CrateDir    = "ffi",
  # Crate name (artifact base name, e.g. deno_mmap_ffi)
  [string]$CrateName   = "deno_mmap_ffi",
  # Target triples to build
  [string[]]$Targets   = @("x86_64-pc-windows-msvc"),
  # release/debug
  [ValidateSet("release","debug")]
  [string]$Configuration = "release",
  # Output directory for final, renamed artifacts
  [string]$OutDir      = "dist",
  # Common Cargo features to enable (comma-separated)
  [string]$Features    = "",
  # Windows-only feature that will be auto-added for Windows targets
  [string]$WindowsFeature = "windows",
  # Skip `rustup target add`
  [switch]$SkipRustup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-OsTagArchExt {
  param([string]$triple)
  # Returns a PSCustomObject { osTag, archTag, ext }
  switch -Regex ($triple) {
    '^(x86_64)-pc-windows-msvc$' { return [pscustomobject]@{ osTag='windows'; archTag='x86_64'; ext='dll' } }
    '^(aarch64)-pc-windows-msvc$' { return [pscustomobject]@{ osTag='windows'; archTag='aarch64'; ext='dll' } }
    '^(x86_64)-unknown-linux-gnu$' { return [pscustomobject]@{ osTag='linux'; archTag='x86_64'; ext='so' } }
    '^(aarch64)-unknown-linux-gnu$' { return [pscustomobject]@{ osTag='linux'; archTag='aarch64'; ext='so' } }
    '^(aarch64)-apple-darwin$' { return [pscustomobject]@{ osTag='macos'; archTag='aarch64'; ext='dylib' } }
    '^(x86_64)-apple-darwin$' { return [pscustomobject]@{ osTag='macos'; archTag='x86_64'; ext='dylib' } }
    default { throw "Unsupported target triple: $triple" }
  }
}

function Resolve-BuiltArtifactPath {
  param(
    [string]$triple,
    [string]$crateDir,
    [string]$crateName,
    [string]$configuration
  )
  # Returns full path to the produced .dll/.so/.dylib inside target/<triple>/<config>/
  $targetDir = Join-Path $crateDir (Join-Path (Join-Path "target" $triple) $configuration)
  switch -Regex ($triple) {
    'pc-windows-msvc$'    { return (Join-Path $targetDir "$crateName.dll") }
    'unknown-linux-gnu$'  { return (Join-Path $targetDir ("lib{0}.so" -f $crateName)) }
    'apple-darwin$'       { return (Join-Path $targetDir ("lib{0}.dylib" -f $crateName)) }
    default { throw "Unsupported triple for path resolution: $triple" }
  }
}

function Make-AssetName {
  param(
    [string]$crateName,
    [string]$osTag,
    [string]$archTag,
    [string]$ext
  )
  # Final asset file name used by loader and checksums.json
  return "{0}-{1}-{2}.{3}" -f $crateName, $osTag, $archTag, $ext
}

function Ensure-Tool { param([string]$name)
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name not found" }
}

# --- sanity checks ---
Ensure-Tool cargo
$manifest = Join-Path $CrateDir "Cargo.toml"
if (-not (Test-Path $manifest)) { throw "Cargo.toml not found at: $manifest" }

# Prepare output
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$checksumsTxt  = Join-Path $OutDir "checksums.txt"
$checksumsJson = Join-Path $OutDir "checksums.json"
if (Test-Path $checksumsTxt)  { Remove-Item $checksumsTxt  -Force }
if (Test-Path $checksumsJson) { Remove-Item $checksumsJson -Force }

# Mapping for JSON: asset -> sha256 (lowercase)
$hashMap = @{}

foreach ($t in $Targets) {
  $info = Resolve-OsTagArchExt $t
  Write-Host "==> Building $t ($Configuration) -> $($info.osTag)/$($info.archTag)" -ForegroundColor Cyan

  if (-not $SkipRustup) { & rustup target add $t | Out-Null }

  $cargoArgs = @("build", "--manifest-path", $manifest, "--target", $t)
  if ($Configuration -eq "release") { $cargoArgs += "--release" }

  # Build features list:
  $featList = @()
  if ($Features -and $Features.Trim() -ne "") { $featList += $Features.Trim() }
  if ($info.osTag -eq 'windows' -and $WindowsFeature -and $WindowsFeature.Trim() -ne "") {
    # auto-append Windows-only feature
    $featList += $WindowsFeature.Trim()
  }
  if ($featList.Count -gt 0) {
    # Cargo accepts comma-separated list in one --features flag
    $cargoArgs += @("--features", ($featList -join ","))
  }

  # Build
  & cargo @cargoArgs

  # Locate built artifact
  $builtPath = Resolve-BuiltArtifactPath -triple $t -crateDir $CrateDir -crateName $CrateName -configuration $Configuration
  if (-not (Test-Path $builtPath)) { throw "Built artifact not found: $builtPath" }

  # Final asset name + copy to dist root (flat layout)
  $assetName = Make-AssetName -crateName $CrateName -osTag $info.osTag -archTag $info.archTag -ext $info.ext
  $destPath  = Join-Path $OutDir $assetName
  Copy-Item -Path $builtPath -Destination $destPath -Force

  # SHA-256 (lowercase)
  $sha = (Get-FileHash -Algorithm SHA256 $destPath).Hash.ToLower()
  "$sha  $assetName" | Out-File -FilePath $checksumsTxt -Append -Encoding ascii
  $hashMap[$assetName] = $sha

  Write-Host ("   -> {0}" -f $assetName) -ForegroundColor Green
}

# Emit checksums.json
($hashMap | ConvertTo-Json -Depth 2) | Out-File -FilePath $checksumsJson -Encoding ascii

Write-Host "`nDone. Artifacts in '$OutDir'." -ForegroundColor Green
Write-Host "Checksums: $(Resolve-Path $checksumsTxt)"
Write-Host "JSON:      $(Resolve-Path $checksumsJson)"
