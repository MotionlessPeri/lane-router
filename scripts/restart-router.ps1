[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    # Also replace the Codex host. Without it the host and every open Codex conversation keep
    # running across the Router restart, which is the point of the host; with it they are cut, which
    # is what a deploy needs once the host's own code has changed.
    [switch]$CodexHost,
    # The Router's data root. Defaults to the shared one; point it at an isolated directory to
    # exercise this script without touching the Router everyone else is using.
    [string]$DataRoot = (Join-Path $env:USERPROFILE ".lane-router")
)

$ErrorActionPreference = "Stop"

# Derived from this script's own location rather than written down: the repo sits at a different
# path on each machine, and a hardcoded one fails on every machine but the author's - reporting a
# missing build, which reads as "you forgot to compile" rather than "this path is not yours".
$laneRouterRoot = Split-Path -Parent $PSScriptRoot
$laneRouterDataRoot = [System.IO.Path]::GetFullPath($DataRoot)
$discoveryPath = Join-Path $laneRouterDataRoot "discovery.json"
$hostDiscoveryPath = Join-Path $laneRouterDataRoot "codex-host.json"
$routerMainPath = Join-Path $laneRouterRoot "dist\process\main.js"
$hostMainPath = Join-Path $laneRouterRoot "dist\process\codex-host.js"
$ensureRouterPath = Join-Path $laneRouterRoot "dist\process\ensure-router.js"
$ensureHostPath = Join-Path $laneRouterRoot "dist\process\ensure-codex-host.js"

foreach ($required in @($routerMainPath, $ensureRouterPath, $hostMainPath, $ensureHostPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Lane Router build is missing: $required. Run npm run build in $laneRouterRoot first."
    }
}

# A process named in a discovery file, but only if it really is the expected entry point of this
# checkout: a pid outlives its process, and a reused one must never be stopped by mistake.
function Get-OwnedProcess([string]$path, [string]$entryPoint, [string]$label) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    $discovery = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($discovery.pid -isnot [int] -and $discovery.pid -isnot [long]) {
        throw "$label discovery has an invalid pid: $path"
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($discovery.pid)" -ErrorAction SilentlyContinue
    if ($null -eq $process) { return $null }
    $normalizedCommandLine = ($process.CommandLine -replace '/', '\')
    if ($process.Name -ne "node.exe" -or $normalizedCommandLine.IndexOf($entryPoint, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "Refusing to stop PID $($discovery.pid): it is not this $label process."
    }
    return $process
}

# Stopping a node process on Windows is a hard kill, so its children are not told; an App Server
# left behind keeps its port and its loaded threads. Children keep the dead parent's pid, which is
# how they are still found here.
function Get-AppServerChildren($parent) {
    if ($null -eq $parent) { return @() }
    return @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($parent.ProcessId)" -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "codex.exe" -and $_.CommandLine -match '(?i)\bapp-server\b' })
}

function Stop-OwnedProcess($process, [string]$label) {
    # Gone already is stopped: under "Stop" a pid that exited since it was found would abort the
    # restart halfway, with the Router down and nothing started in its place.
    try { Stop-Process -Id $process.ProcessId -ErrorAction Stop } catch {
        if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) { throw }
    }
    try {
        Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction Stop
    } catch {
        if (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue) {
            throw "$label PID $($process.ProcessId) did not stop within 10 seconds."
        }
    }
}

# An App Server usually goes down with its parent, and its pid may name some other process by the
# time this runs. Only the process that was found - same name, same start time - is stopped, and
# one that has already exited is simply done.
function Stop-AppServerChild($child) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.ProcessId)" -ErrorAction SilentlyContinue
    if ($null -eq $current -or $current.Name -ne $child.Name -or $current.CreationDate -ne $child.CreationDate) { return }
    try { Stop-Process -Id $child.ProcessId -ErrorAction Stop } catch {
        if (Get-Process -Id $child.ProcessId -ErrorAction SilentlyContinue) { throw }
    }
}

$routerProcess = Get-OwnedProcess $discoveryPath $routerMainPath "Lane Router"
# The Router has no App Server of its own since the Codex host took it over. Only a Router from
# before that change still has one, and this is what stops it during the first upgrade.
# @() again at the call: a function that returns one object hands back the object itself, which
# has no Count.
$routerAppServers = @(Get-AppServerChildren $routerProcess)
$hostProcess = if ($CodexHost) { Get-OwnedProcess $hostDiscoveryPath $hostMainPath "Codex host" } else { $null }
$hostAppServers = @(Get-AppServerChildren $hostProcess)

if ($WhatIfPreference) {
    if ($null -ne $routerProcess) {
        Write-Host "Would restart Lane Router PID $($routerProcess.ProcessId) and $($routerAppServers.Count) Codex app-server child process(es) of an older Router build."
    } else {
        Write-Host "Would start Lane Router (no live Router process was found)."
    }
    if ($CodexHost) {
        if ($null -ne $hostProcess) {
            Write-Host "Would restart Codex host PID $($hostProcess.ProcessId) and its $($hostAppServers.Count) Codex app-server child process(es); open Codex conversations would disconnect."
        } else {
            Write-Host "Would start a Codex host (no live Codex host process was found)."
        }
    }
    return
}

# From the moment the Router is stopped until a new one answers, a failure leaves nothing running.
# Saying so is the least a halfway restart owes: run again, this script finds no Router to stop and
# goes straight to starting one.
$routerDown = $false
trap {
    if ($routerDown) { Write-Warning "Lane Router is not running: the restart stopped partway. Run this script again to start it." }
    break
}

if ($null -ne $routerProcess -and $PSCmdlet.ShouldProcess("Lane Router PID $($routerProcess.ProcessId)", "Restart")) {
    $routerDown = $true
    Stop-OwnedProcess $routerProcess "Lane Router"
    foreach ($child in $routerAppServers) { Stop-AppServerChild $child }
}

# After the Router, so that a Router still running cannot bring the old host straight back.
if ($null -ne $hostProcess -and $PSCmdlet.ShouldProcess("Codex host PID $($hostProcess.ProcessId)", "Restart")) {
    Stop-OwnedProcess $hostProcess "Codex host"
    foreach ($child in $hostAppServers) { Stop-AppServerChild $child }
}

function Invoke-Ensure([string]$module, [string]$function, [string]$label) {
    Push-Location -LiteralPath $laneRouterRoot
    # Under "Stop", the first line node writes to stderr becomes a terminating error and the rest
    # of the reason is lost; the exit code below is what decides failure.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # The data root travels as an argument, not inside the code: Windows PowerShell mangles
        # double quotes embedded in a native command's arguments. 60 s rather than the 15 s default:
        # a Router on a loaded machine has taken 15 s to publish discovery (2026-10-19), and a
        # restart that worked must not be reported as failed.
        $output = @(& node --input-type=module -e "import { $function } from './dist/process/$module'; console.log(JSON.stringify(await $function({ dataRoot: process.argv[1], timeoutMs: 60000 })));" $laneRouterDataRoot 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        Pop-Location
    }
    if ($exitCode -ne 0) {
        throw "$label failed to start:`n$($output -join [Environment]::NewLine)"
    }
    $line = $output | Where-Object { $_.ToString().Trim().Length -gt 0 } | Select-Object -Last 1
    try {
        $result = $line.ToString() | ConvertFrom-Json
    } catch {
        throw "$label started but returned unexpected output:`n$($output -join [Environment]::NewLine)"
    }
    $health = Invoke-RestMethod -Uri "$($result.url)/health" -TimeoutSec 5
    if ($health.instanceId -ne $result.instanceId -or $health.pid -ne $result.pid) {
        throw "$label health check did not match the newly started instance."
    }
    return $result
}

$router = Invoke-Ensure "ensure-router.js" "ensureRouter" "Lane Router"
$routerDown = $false
Write-Host "Lane Router restarted successfully."
Write-Host "PID: $($router.pid)"
Write-Host "Dashboard: $($router.url)/dashboard"

if ($CodexHost) {
    # The new Router ensures a host on its own; asking here as well waits for it and checks it, and
    # the startup lock keeps the two from starting a second one.
    $codexHostResult = Invoke-Ensure "ensure-codex-host.js" "ensureCodexHost" "Codex host"
    Write-Host "Codex host restarted successfully."
    Write-Host "Codex host PID: $($codexHostResult.pid)"
}
