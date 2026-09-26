<#
CaptureDesk — stage the engine executable with its complete runtime DLL
closure (pipeline helper for release.yml / ci.yml / release-v2.sh).

Why this exists: the engine links FFmpeg through vcpkg's dynamic triplet, so
on a clean user machine it needs avformat/avcodec/avutil/swscale/swresample
(+ their own transitive dependencies) and the MSVC CRT DLLs next to the exe.
The Windows loader searches the exe's own folder first, so staging there is
sufficient — and missing DLLs surface at launch as "The code execution
cannot proceed because avformat-63.dll was not found".

Usage:
  pwsh scripts/stage-engine-runtime.ps1 -EngineExe <path> -VcpkgBin <dir> -OutDir <dir>

Behaviour:
  - copies the engine exe into OutDir
  - walks the import table recursively via dumpbin (VS auto-detected)
  - DLLs found in VcpkgBin            -> copied from there, then recursed
  - MSVC CRT (msvcp*/vcruntime*/concrt*) -> copied app-local from System32
  - anything resolvable from System32 -> treated as an OS component, skipped
  - anything else                     -> HARD FAIL (packaging regression guard)
  - if dumpbin is unavailable, falls back to copying every DLL in VcpkgBin
    (provably complete superset) + the CRT files
#>
param(
  [Parameter(Mandatory = $true)][string]$EngineExe,
  [Parameter(Mandatory = $true)][string]$VcpkgBin,
  [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $EngineExe)) { throw "engine exe not found: $EngineExe" }
if (-not (Test-Path $VcpkgBin))  { throw "vcpkg bin dir not found: $VcpkgBin" }

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
  $out = (& $Dumpbin -DEPENDENTS $Binary 2>$null | Out-String)
  $names = @()
  $in = $false
  foreach ($line in ($out -split "`r?`n")) {
    if ($line -match 'dependencies:') { $in = $true; continue }
    if ($in -and $line -match '^\s{4,}(\S+\.dll)\s*$') { $names += $Matches[1].ToLower(); continue }
    if ($in -and $line -match '^\s*$') { $in = $false; continue }
    if ($line -match '^\s*Summary') { $in = $false }
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
Copy-Item $EngineExe $stage -Force
Write-Host "staged engine: $EngineExe"

$copied = New-Object 'System.Collections.Generic.HashSet[string]'
$queue  = New-Object 'System.Collections.Generic.Queue[string]'

function Stage-Dll([string]$Name) {
  $lower = $Name.ToLower()
  if (-not $copied.Add($lower)) { return }   # already processed

  $fromVcpkg = Join-Path $VcpkgBin $Name
  if (Test-Path $fromVcpkg) {
    Copy-Item $fromVcpkg $stage -Force
    Write-Host "  + $Name  (vcpkg)"
    foreach ($dep in (Get-Imports $fromVcpkg $dumpbin)) { $queue.Enqueue($dep) }
    return
  }

  if ($CrtDlls -contains $lower) {
    $src32 = Join-Path "$env:SystemRoot\System32" $Name
    if (Test-Path $src32) {
      Copy-Item $src32 $stage -Force
      Write-Host "  + $Name  (MSVC CRT, app-local)"
      return
    }
    throw "MSVC CRT DLL '$Name' not found in System32 — cannot ship the engine runtime"
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
  foreach ($dep in (Get-Imports $EngineExe $dumpbin)) { $queue.Enqueue($dep) }
  while ($queue.Count -gt 0) { Stage-Dll ($queue.Dequeue()) }
}
else {
  # Superset fallback: every non-OS dependency of the engine or of any vcpkg
  # DLL lives in the vcpkg bin dir by construction of the dynamic triplet.
  Copy-Item (Join-Path $VcpkgBin '*.dll') $stage -Force
  foreach ($c in $CrtDlls) {
    $src32 = Join-Path "$env:SystemRoot\System32" $c
    if (Test-Path $src32) { Copy-Item $src32 $stage -Force }
  }
}

Write-Host ""
Write-Host "engine stage ready ($((Get-ChildItem $stage).Count) files):"
Get-ChildItem $stage | ForEach-Object { Write-Host ("  {0,12:N0}  {1}" -f $_.Length, $_.Name) }
