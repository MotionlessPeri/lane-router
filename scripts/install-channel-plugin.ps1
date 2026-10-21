<#
.SYNOPSIS
  One-time install, per machine, of the lane plugin that gives Claude lanes their channel (LR-24).

.DESCRIPTION
  Claude Code asks for a click on every launch that uses the development channel flag. A plugin's
  channel on the managed allow-list is let in without asking, so Claude lanes now start with
  `--channels plugin:lane@lane-local`. This script makes that work on this machine, in an order
  that matters:

    1. validate the plugin package in this repository;
    2. add its directory as the `lane-local` marketplace and install `lane@lane-local` for the user;
    3. check that the managed settings let the plugin's channel in. Writing that file needs an
       administrator, so this script never writes it: it prints the whole file to write and stops;
    4. remove the user-scope `lane` MCP server. Left beside the plugin, it would give every session
       two lane servers (LR-30). Removed before step 3 holds, new lanes would have no channel at all,
       which is why the script stops at 3 when the allow-list is missing.

  Every step checks first and skips what is already done, so running it again is safe. It touches
  neither the Router nor any lane, and never the managed settings file.

  Spec docs/superpowers/specs/2026-10-21-channel-plugin-migration.md, 4.2.

.PARAMETER Claude
  The Claude Code command. Tests hand in a stand-in.

.PARAMETER ManagedSettings
  The managed settings file Claude Code reads on this machine.
#>
param(
    [string]$Claude = "claude",
    [string]$ManagedSettings = "C:\Program Files\ClaudeCode\managed-settings.json",
    [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$pluginRoot = Join-Path $Repo "tools\channel-plugin"

function Invoke-Claude([string[]]$Arguments) {
    $output = & $Claude @Arguments
    if ($LASTEXITCODE -ne 0) { throw "claude $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
    return $output
}

function Get-ClaudeJson([string[]]$Arguments) {
    # Windows PowerShell's ConvertFrom-Json hands a JSON array on as one object, and a filter on it
    # then compares every item's field at once: lane at local scope beside another plugin at user
    # scope read as "installed for the user" (2026-10-21 deploy). The items themselves go on here.
    $parsed = ((Invoke-Claude $Arguments) -join "`n") | ConvertFrom-Json
    foreach ($item in $parsed) { $item }
}

function Test-SamePath([string]$a, [string]$b) {
    return [System.IO.Path]::GetFullPath($a).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($b).TrimEnd('\')
}

# Step 1: the package itself.
Invoke-Claude @("plugin", "validate", $pluginRoot) | Out-Null
Write-Host "plugin package: valid ($pluginRoot)"

# Step 2: the marketplace and the plugin, for the user.
$marketplace = @(Get-ClaudeJson @("plugin", "marketplace", "list", "--json")) | Where-Object { $_.name -eq "lane-local" } | Select-Object -First 1
if ($null -ne $marketplace) {
    if (-not (Test-SamePath $marketplace.path $pluginRoot)) {
        throw "The lane-local marketplace points at $($marketplace.path), not $pluginRoot. Remove it first: claude plugin marketplace remove lane-local"
    }
    Write-Host "marketplace lane-local: already added, skipped"
} else {
    Invoke-Claude @("plugin", "marketplace", "add", $pluginRoot) | Out-Null
    Write-Host "marketplace lane-local: added"
}

$installed = @(Get-ClaudeJson @("plugin", "list", "--json")) | Where-Object { $_.id -eq "lane@lane-local" -and $_.scope -eq "user" } | Select-Object -First 1
if ($null -ne $installed) {
    Write-Host "plugin lane@lane-local (user): already installed, skipped"
} else {
    Invoke-Claude @("plugin", "install", "lane@lane-local", "--scope", "user") | Out-Null
    Write-Host "plugin lane@lane-local (user): installed"
}

# Step 3: the managed allow-list, read and never written.
$settings = if (Test-Path -LiteralPath $ManagedSettings) { Get-Content -LiteralPath $ManagedSettings -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$allowed = @($settings.allowedChannelPlugins) | Where-Object { $_.marketplace -eq "lane-local" -and $_.plugin -eq "lane" }
if (@($allowed).Count -eq 0) {
    $entries = @(@($settings.allowedChannelPlugins) | Where-Object { $null -ne $_ }) + [pscustomobject]@{ marketplace = "lane-local"; plugin = "lane" }
    $settings | Add-Member -NotePropertyName allowedChannelPlugins -NotePropertyValue $entries -Force
    Write-Host ""
    Write-Host "The managed settings do not let the lane plugin's channel in yet. As an administrator, write this to"
    Write-Host "  $ManagedSettings"
    Write-Host ""
    Write-Host ($settings | ConvertTo-Json -Depth 20)
    Write-Host ""
    Write-Host "Then run this script again. The user-scope lane server is left in place until then, so lanes keep their channel."
    exit 2
}
Write-Host "managed allow-list: lets lane@lane-local in"

# Step 4: the user-scope server the plugin replaces. "Not registered" is an exit code and a line on
# stderr, which Windows PowerShell turns into a terminating error under "Stop"; so not here.
$ErrorActionPreference = "Continue"
$registered = (& $Claude mcp get lane 2>&1 | ForEach-Object { "$_" }) -join "`n"
$found = $LASTEXITCODE -eq 0
$ErrorActionPreference = "Stop"
if ($found -and $registered -match "Scope:\s*User config") {
    Invoke-Claude @("mcp", "remove", "lane", "-s", "user") | Out-Null
    Write-Host "user-scope lane MCP server: removed"
} else {
    Write-Host "user-scope lane MCP server: not registered, skipped"
}

Write-Host ""
Write-Host "Done. Lanes opened, woken or rotated from now on use the plugin's channel and ask nothing."
Write-Host "A Claude lane already open keeps working; close it and run lane-router-lane open <lane> to move it over."
