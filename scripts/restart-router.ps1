[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param()

$ErrorActionPreference = "Stop"

$laneRouterRoot = "D:\my_projects\lane-router"
$laneRouterDataRoot = Join-Path $env:USERPROFILE ".lane-router"
$discoveryPath = Join-Path $laneRouterDataRoot "discovery.json"
$routerMainPath = Join-Path $laneRouterRoot "dist\process\main.js"
$ensureRouterPath = Join-Path $laneRouterRoot "dist\process\ensure-router.js"

if (-not (Test-Path -LiteralPath $routerMainPath -PathType Leaf)) {
    throw "Lane Router build is missing: $routerMainPath. Run npm run build in $laneRouterRoot first."
}
if (-not (Test-Path -LiteralPath $ensureRouterPath -PathType Leaf)) {
    throw "Lane Router launcher is missing: $ensureRouterPath. Run npm run build in $laneRouterRoot first."
}

$routerProcess = $null
$codexChildProcesses = @()

if (Test-Path -LiteralPath $discoveryPath -PathType Leaf) {
    $discovery = Get-Content -LiteralPath $discoveryPath -Raw | ConvertFrom-Json
    if ($discovery.pid -isnot [int] -and $discovery.pid -isnot [long]) {
        throw "Lane Router discovery has an invalid pid: $discoveryPath"
    }

    $routerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($discovery.pid)" -ErrorAction SilentlyContinue
    if ($null -ne $routerProcess) {
        $normalizedCommandLine = ($routerProcess.CommandLine -replace '/', '\')
        if ($routerProcess.Name -ne "node.exe" -or $normalizedCommandLine.IndexOf($routerMainPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "Refusing to stop PID $($discovery.pid): it is not this Lane Router process."
        }

        $codexChildProcesses = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($discovery.pid)" -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq "codex.exe" -and $_.CommandLine -match '(?i)\bapp-server\b' })
    }
}

if ($WhatIfPreference) {
    if ($null -ne $routerProcess) {
        Write-Host "Would restart Lane Router PID $($routerProcess.ProcessId) and $($codexChildProcesses.Count) Codex app-server child process(es)."
    } else {
        Write-Host "Would start Lane Router (no live Router process was found)."
    }
    return
}

if ($null -ne $routerProcess -and $PSCmdlet.ShouldProcess("Lane Router PID $($routerProcess.ProcessId)", "Restart")) {
    Stop-Process -Id $routerProcess.ProcessId
    try {
        Wait-Process -Id $routerProcess.ProcessId -Timeout 10 -ErrorAction Stop
    } catch {
        if (Get-Process -Id $routerProcess.ProcessId -ErrorAction SilentlyContinue) {
            throw "Lane Router PID $($routerProcess.ProcessId) did not stop within 10 seconds."
        }
    }

    foreach ($codexChild in $codexChildProcesses) {
        if (Get-Process -Id $codexChild.ProcessId -ErrorAction SilentlyContinue) {
            Stop-Process -Id $codexChild.ProcessId
        }
    }
}

Push-Location -LiteralPath $laneRouterRoot
try {
    $launcherOutput = @(& node --input-type=module -e "import { ensureRouter } from './dist/process/ensure-router.js'; console.log(JSON.stringify(await ensureRouter()));" 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "Lane Router failed to start:`n$($launcherOutput -join [Environment]::NewLine)"
    }
} finally {
    Pop-Location
}

$resultLine = $launcherOutput | Where-Object { $_.ToString().Trim().Length -gt 0 } | Select-Object -Last 1
try {
    $result = $resultLine.ToString() | ConvertFrom-Json
} catch {
    throw "Lane Router started but returned unexpected output:`n$($launcherOutput -join [Environment]::NewLine)"
}

$health = Invoke-RestMethod -Uri "$($result.url)/health" -TimeoutSec 5
if ($health.instanceId -ne $result.instanceId -or $health.pid -ne $result.pid) {
    throw "Lane Router health check did not match the newly started instance."
}

Write-Host "Lane Router restarted successfully."
Write-Host "PID: $($result.pid)"
Write-Host "Dashboard: $($result.url)/dashboard"
