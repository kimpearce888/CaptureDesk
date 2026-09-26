<#
CaptureDesk — verify the engine executable's runtime import closure
(pipeline helper for release.yml / ci.yml / release-v2.sh).

Why this exists: the engine used to link FFmpeg through vcpkg's dynamic
triplet, so on a clean user machine it needed avformat/avcodec/avutil/swscale/
swresample (+ their transitive dependencies) and the MSVC CRT DLLs next to the
exe; missing DLLs surfaced at launch as "The code execution cannot proceed
because avformat-63.dll was not found". The engine now uses the vcpkg
x64-windows-static triplet (FFmpeg, x264, opus and the CRT baked INTO the exe),
so the shipped engine needs ZERO companion DLLs. This script remains as the
packaging regression guard:

  - walks the import table recursively via dumpbin (VS auto-detected)
  - DLLs found in VcpkgBin            -> staged (copied) when not self-contained
  - MSVC CRT (msvcp*/vcruntime*/concrt*) -> staged app-local when not self-contained
  - anything resolvable from System32 -> treated as an OS component, skipped
  - API set virtual DLLs (api-ms-win-*, ext-ms-*) -> loader-resolved, skipped
  - anything else                     -> HARD FAIL (packaging regression guard)
  - with -RequireSelfContained (CI + release), ANY import that would demand a
    companion DLL is itself a HARD FAIL — the engine must stay self-contained.
  - if dumpbin is unavailable, falls back to copying every DLL in VcpkgBin
    (provably complete superset) + the CRT files

Usage:
  pwsh scripts/stage-engine-runtime.ps1 -EngineExe <path> -VcpkgBin <dir> -OutDir <dir> [-RequireSelfContained]
#>
param(
  [Parameter(Mandatory = $true)][string]$EngineExe,
  [Parameter(Mandatory = $true)][string]$VcpkgBin,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [switch]$RequireSelfContained
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $EngineExe)) { throw "engine exe not found: $EngineExe" }

# The static triplet does not produce a DLL bin dir — tolerate its absence.
# Any import that would have needed it still hard-fails below.
if (Test-Path $VcpkgBin) {
  $VcpkgBinPresent = $true
}
else {
  $VcpkgBinPresent = $false
  Write-Warning "vcpkg bin dir not found: $VcpkgBin (expected for the static triplet)"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# MSVC runtime DLLs: ship app-local so machines without the VC++ redistributable work.
$CrtDlls = @(
  'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll',
  'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll'
)

function Find-Dumpbin {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1
    if ($vs) {
      $pat = Join-Path $vs 'VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe'
      $cands = Get-ChildItem -Path $pat -ErrorAction SilentlyContinue
      if ($cands) { return ($cands | Sort-Object FullName | Select-Object -Last 1).FullName }
    }
  }
  foreach ($root in @(${env:ProgramFiles}, ${env:ProgramFiles(x86)})) {
    if (-not $root) { continue }
    $pat = Join-Path $root 'Microsoft Visual Studio\*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe'
    $cands = Get-ChildItem -Path $pat -ErrorAction SilentlyContinue
    if ($cands) { return ($cands | Sort-Object FullName | Select-Object -Last 1).FullName }
  }
  return $null
}

function Get-Imports([string]$Binary, [string]$Dumpbin) {
  # Capture stderr too: a dumpbin failure must not look like "zero imports".
  $out = (& $Dumpbin -DEPENDENTS $Binary 2>&1 | Out-String)
  $names = @()
  # Format-agnostic: every dependency dumpbin prints is a 2+ space indented
  # line ending in a .dll name (the Summary section lists .text/.data etc.,
  # never .dll). No dependence on header wording across MSVC versions.
  foreach ($line in ($out -split '\r?\n')) {
    if ($line -match '^\s{2,}(\S+\.dll)\s*$') { $names += $Matches[1].ToLower() }
  }
  return $names | Select-Object -Unique
}

$dumpbin = Find-Dumpbin
if ($dumpbin) {
  Write-Host "dumpbin: $dumpbin"
}
else {
  Write-Warning "dumpbin not found — falling back to staging the whole vcpkg bin dir"
}

$stage = $OutDir
$EngineAbs = (Resolve-Path $EngineExe).Path
Copy-Item $EngineAbs $stage -Force
Write-Host "staged engine: $EngineAbs"

$copied = New-Object 'System.Collections.Generic.HashSet[string]'
$queue  = New-Object 'System.Collections.Generic.Queue[string]'

function Stage-Dll([string]$Name) {
  $lower = $Name.ToLower()
  if (-not $copied.Add($lower)) { return }   # already processed

  if ($VcpkgBinPresent) {
    $fromVcpkg = Join-Path $VcpkgBin $Name
    if (Test-Path $fromVcpkg) {
      if ($RequireSelfContained) {
        throw ("engine is not self-contained: it imports '{0}', a DLL from the " +
               "vcpkg bin dir. FFmpeg must stay statically linked " +
               "(VCPKG_TARGET_TRIPLET=x64-windows-static).") -f $Name
      }
      Copy-Item $fromVcpkg $stage -Force
      Write-Host "  + $Name  (vcpkg)"
      foreach ($dep in (Get-Imports $fromVcpkg $dumpbin)) { $queue.Enqueue($dep) }
      return
    }
  }

  if ($CrtDlls -contains $lower) {
    if ($RequireSelfContained) {
      throw ("engine is not self-contained: it imports the dynamic CRT DLL " +
             "'{0}'. Build against the static CRT (x64-windows-static).") -f $Name
    }
    $src32 = Join-Path "$env:SystemRoot\System32" $Name
    if (Test-Path $src32) {
      Copy-Item $src32 $stage -Force
      Write-Host "  + $Name  (MSVC CRT, app-local)"
      return
    }
    throw "MSVC CRT DLL '$Name' not found in System32 — cannot ship the engine runtime"
  }

  # API Set virtual DLLs (api-ms-win-*, ext-ms-*): no file on disk anywhere —
  # the loader resolves them through the API Set schema. Always OS-provided.
  if ($lower -match '^(api-ms-win|ext-ms)-') {
    Write-Host "  = $Name  (API set, loader-resolved)"
    return
  }

  $src32 = Join-Path "$env:SystemRoot\System32" $Name
  if (Test-Path $src32) {
    Write-Host "  = $Name  (OS component, skipped)"
    return
  }

  throw ("unresolved import '{0}' — not in vcpkg bin, not MSVC CRT, not an OS DLL. " +
         "Refusing to package an engine that would fail at launch." ) -f $Name
}

if ($dumpbin) {
  $engineImports = @(Get-Imports $EngineAbs $dumpbin)
  if ($engineImports.Count -eq 0) {
    $dbg = @(& $dumpbin -DEPENDENTS $EngineAbs 2>&1 | Out-String) -join "`n"
    $head = (($dbg -split '\r?\n') | Select-Object -First 40) -join "`n"
    throw ("import-table parse returned no dependencies (dumpbin exit {0}).`n" +
           "--- dumpbin output (first 40 lines) ---`n{1}") -f $LASTEXITCODE, $head
  }
  Write-Host ("engine imports ({0}): {1}" -f $engineImports.Count, ($engineImports -join ', '))
  foreach ($dep in $engineImports) { $queue.Enqueue($dep) }
  while ($queue.Count -gt 0) { Stage-Dll ($queue.Dequeue()) }
}
else {
  # Superset fallback (dumpbin unavailable): every non-OS dependency of the
  # engine or of any vcpkg DLL lives in the vcpkg bin dir by construction of
  # the dynamic triplet. In self-contained mode we cannot verify the import
  # table — fail loudly instead of shipping an unverifiable engine.
  if ($RequireSelfContained) {
    throw "dumpbin not found: cannot verify that the engine is self-contained"
  }
  if ($VcpkgBinPresent) {
    Copy-Item (Join-Path $VcpkgBin '*.dll') $stage -Force
  }
  foreach ($c in $CrtDlls) {
    $src32 = Join-Path "$env:SystemRoot\System32" $c
    if (Test-Path $src32) { Copy-Item $src32 $stage -Force }
  }
}

Write-Host ""
$copiedCount = @(Get-ChildItem $stage -Filter '*.dll').Count
if ($RequireSelfContained) {
  if ($copiedCount -gt 0) {
    throw "self-contained engine expected 0 companion DLLs, staged $copiedCount"
  }
  Write-Host "engine is SELF-CONTAINED: every import resolves from the OS — no companion DLLs to ship"
}
elseif ($dumpbin -and $copiedCount -eq 0) {
  throw "no DLLs were staged — the engine would launch without its FFmpeg runtime"
}
Write-Host "engine stage ready ($copiedCount DLLs + 1 exe):"
Get-ChildItem $stage | ForEach-Object { Write-Host ("  {0,12:N0}  {1}" -f $_.Length, $_.Name) }
