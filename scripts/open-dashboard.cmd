@echo off
setlocal
title Lane Router - Dashboard
rem The port changes on every Router restart, so the URL is read from discovery.json rather than
rem written down. The health check runs first because a stale discovery.json outlives the process
rem it names: without it a dead Router opens a browser tab that never loads, which reads as "the
rem dashboard is broken" instead of "the Router is not running".
rem Keep this file ASCII-only - cmd.exe reads it in the OEM codepage and mangles anything else.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $path = Join-Path $env:USERPROFILE '.lane-router\discovery.json'; $d = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json; if ($null -eq $d.url) { throw 'Lane Router discovery.json has no URL.' }; $health = Invoke-WebRequest -Uri ($d.url.TrimEnd('/') + '/health') -UseBasicParsing -TimeoutSec 3; if ($health.StatusCode -ne 200) { throw 'Lane Router health check failed.' }; Start-Process ($d.url.TrimEnd('/') + '/dashboard') } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 pause
