# Bridge for a lane that runs on another machine while the Router stays here.
#
# The Router binds loopback only and this machine has no sshd, so the link has to be opened
# from here, as one ssh session with two reverse forwards:
#   -R <router-port>  : remote 127.0.0.1:<router-port> -> this Router (HTTP + channel WebSocket)
#   -R <mailbox-port> : remote 127.0.0.1:<mailbox-port> -> a read-only static server over
#                       ~/.lane-router/mailboxes, because a notification names a Windows path
#                       the remote lane cannot read. Its role description maps the path onto
#                       http://127.0.0.1:<mailbox-port>/<project>/<lane>/pending/...
# discovery.json is copied over first: the remote MCP server finds the Router by instanceId.
#
# The tunnel is re-opened when it drops (network blip, VM reboot, machine sleep) AND when the
# Router is replaced. The second case needs watching on purpose: a restarted Router listens on
# a new port, but the ssh session forwarding the old one stays up, so waiting for ssh to exit
# would leave the remote lane pointed at a dead port indefinitely (measured 2026-10-12).
# Closing this window is the only way to stop the bridge; the remote lane then shows
# reach = no_channel until it is started again.
# ASCII only: PowerShell 5.1 parses this file.
param(
    [Parameter(Mandatory = $true)] [string] $VmHost,
    [Parameter(Mandatory = $true)] [string] $VmUser,
    [int] $MailboxPort = 57880,
    [int] $WatchSeconds = 5
)
$ErrorActionPreference = "Stop"
$dataRoot = Join-Path $env:USERPROFILE ".lane-router"
$discoveryPath = Join-Path $dataRoot "discovery.json"
$target = "$VmUser@$VmHost"
$sshOpts = @("-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new")
$static = $null
$tunnel = $null

function Stamp { (Get-Date).ToString("HH:mm:ss") }

function Read-LiveRouter {
    $discovery = Get-Content $discoveryPath -Raw | ConvertFrom-Json
    $health = Invoke-RestMethod -Uri "$($discovery.url)/health" -TimeoutSec 5
    if ($health.instanceId -ne $discovery.instanceId) { throw "discovery.json does not match the live Router" }
    return $discovery
}

function Current-InstanceId {
    # A Router mid-restart can leave discovery.json briefly missing or half-written; that is
    # "unknown", not "changed", so the watch does not tear down a working tunnel on it.
    try { return (Get-Content $discoveryPath -Raw | ConvertFrom-Json).instanceId } catch { return $null }
}

function Ensure-StaticServer {
    # Read-only, loopback only, rooted at mailboxes/ so URLs match the role description mapping.
    if ($script:static -and -not $script:static.HasExited) { return }
    $script:static = Start-Process -FilePath python -ArgumentList @("-m", "http.server", "$MailboxPort", "--bind", "127.0.0.1", "--directory", (Join-Path $dataRoot "mailboxes")) -PassThru -WindowStyle Hidden
    Write-Host "$(Stamp) mailbox static server: pid $($script:static.Id) on 127.0.0.1:$MailboxPort (GET only)"
}

try {
    $delay = 5
    while ($true) {
        try {
            $discovery = Read-LiveRouter
            $routerPort = [int]$discovery.port
            $openedFor = $discovery.instanceId
            Write-Host "$(Stamp) Router pid $($discovery.pid) port $routerPort instance $openedFor"
            Ensure-StaticServer

            # A tunnel that died without closing can leave sshd on the VM holding the listen
            # ports; ExitOnForwardFailure would then refuse the new one. Only no-tty sessions
            # are killed: interactive logins (PuTTY, pts) are left alone.
            ssh @sshOpts $target "if ss -ltn | grep -qE ':($routerPort|$MailboxPort) '; then pkill -u $VmUser -f 'sshd: $VmUser@notty' || true; sleep 1; fi; mkdir -p ~/.lane-router"
            scp @sshOpts $discoveryPath "${target}:~/.lane-router/discovery.json"
            Write-Host "$(Stamp) discovery.json copied; tunnel open to $target (close this window to stop)"

            $tunnelArgs = $sshOpts + @("-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes", "-N",
                "-R", "${routerPort}:127.0.0.1:${routerPort}", "-R", "${MailboxPort}:127.0.0.1:${MailboxPort}", $target)
            $script:tunnel = Start-Process -FilePath ssh -ArgumentList $tunnelArgs -PassThru -NoNewWindow

            # Watch both ways the tunnel can go stale: ssh exiting, or the Router being replaced.
            while (-not $script:tunnel.HasExited) {
                Start-Sleep -Seconds $WatchSeconds
                $now = Current-InstanceId
                if ($null -ne $now -and $now -ne $openedFor) {
                    Write-Host "$(Stamp) Router was replaced (instance $now); re-opening the tunnel on its new port"
                    Stop-Process -Id $script:tunnel.Id -Force -ErrorAction SilentlyContinue
                    break
                }
            }
            if ($script:tunnel.HasExited) { Write-Host "$(Stamp) tunnel closed" }
            $delay = 5
        } catch {
            Write-Host "$(Stamp) bridge attempt failed: $($_.Exception.Message)"
        }
        Write-Host "$(Stamp) reconnecting in $delay s ..."
        Start-Sleep -Seconds $delay
        $delay = [Math]::Min($delay * 2, 60)
    }
} finally {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
    if ($static -and -not $static.HasExited) { Stop-Process -Id $static.Id -Force }
    Write-Host "$(Stamp) bridge closed"
}
