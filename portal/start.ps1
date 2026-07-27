# Start Repost Studio. Leave this window open while you use the portal.
$ErrorActionPreference = 'Stop'
$port = 8791

$ip = (Get-NetIPConfiguration |
       Where-Object { $_.IPv4DefaultGateway -ne $null -and $_.NetAdapter.Status -eq 'Up' } |
       Select-Object -First 1).IPv4Address.IPAddress

Write-Host ""
Write-Host "  Repost Studio" -ForegroundColor Yellow
Write-Host "  ----------------------------------------"
Write-Host "  This PC :  http://localhost:$port"
if ($ip) { Write-Host "  Phone   :  http://${ip}:$port   (same Wi-Fi)" -ForegroundColor Green }
Write-Host ""
Write-Host "  On the phone, use the browser's 'Add to Home Screen' to install it."
Write-Host "  Ctrl+C stops the server."
Write-Host ""

# One-time: let the phone through the Windows firewall on this port.
$rule = "Repost Studio $port"
if (-not (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue)) {
  try {
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $port -Profile Private | Out-Null
    Write-Host "  Firewall rule added for port $port (private networks)." -ForegroundColor DarkGray
  } catch {
    Write-Host "  Could not add the firewall rule automatically." -ForegroundColor DarkYellow
    Write-Host "  Run this window as Administrator once if the phone cannot connect." -ForegroundColor DarkYellow
  }
}

python "$PSScriptRoot\server.py"
