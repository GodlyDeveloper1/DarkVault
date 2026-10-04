# The house purse: the coins behind practice auctions and practice wallets.
#
#   powershell -ExecutionPolicy Bypass -File scripts\house.ps1 status
#   powershell -ExecutionPolicy Bypass -File scripts\house.ps1 address
#
# status   what the purse holds, how many deposits are ready, and whether a
#          practice auction can be started.
# address  a fresh shielded address to top the purse up at. Send testnet coins
#          to it from any wallet, for example:
#            powershell -ExecutionPolicy Bypass -File scripts\wallet.ps1 send ADDRESS 0.02
#          (put the address this prints in place of ADDRESS).
#
# It talks to the web app, which must be running with HOUSE_SIGNER_URL and
# VAULT_OPERATOR_KEY set. The key is read from the VAULT_OPERATOR_KEY
# environment variable, or from vault-web\.env.local.

param(
  [Parameter(Position = 0)][string]$Command = "status",
  [string]$Site = "http://127.0.0.1:3100"
)

$ErrorActionPreference = "Stop"
$key = $env:VAULT_OPERATOR_KEY
if (-not $key) {
  $envFile = Join-Path $PSScriptRoot "..\vault-web\.env.local"
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*VAULT_OPERATOR_KEY\s*=" } | Select-Object -First 1
    if ($line) { $key = ($line -split "=", 2)[1].Trim().Trim('"') }
  }
}
if (-not $key -or $key.Length -lt 24) { throw "No operator key found. Set VAULT_OPERATOR_KEY (24 characters or more) in vault-web\.env.local and restart the web app." }
$headers = @{ "x-operator-key" = $key }

function Call($method, $url) {
  try {
    return Invoke-RestMethod -Method $method -Uri $url -Headers $headers -TimeoutSec 120
  } catch {
    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }
    throw "$method $url failed: $detail (a 404 usually means the operator key is wrong or the web app was started without it)"
  }
}

# Always with a decimal point, whatever this computer's language settings, so an amount can be pasted into wallet.ps1.
function Coins($zat) { return ([decimal]$zat / 100000000).ToString("0.########", [System.Globalization.CultureInfo]::InvariantCulture) }

switch ($Command) {
  "status" {
    $s = Call "GET" "$Site/api/operator/house"
    if (-not $s.enabled) { Write-Host "Practice auctions are off. $($s.hint)"; break }
    $p = $s.purse
    if (-not $p.house_signer_online) { Write-Host "The house signer is not reachable. Start it: powershell -ExecutionPolicy Bypass -File scripts\house-signer.ps1"; break }
    if ($p.treasury) { Write-Host "Treasury          $(Coins $p.treasury.total) TAZ ($(Coins $p.treasury.spendable) confirmed)" } else { Write-Host "Treasury          not opened yet (give it a few seconds)" }
    Write-Host "Deposits ready    $($p.slots.ready) of $($p.slots.target) ($(Coins $p.slots.each) TAZ each), $($p.slots.waiting) waiting for confirmations"
    Write-Host "Practice auctions $($p.practice_auctions) so far"
    if ($s.practice.open) { Write-Host "Open now          $($s.practice.open.title)" }
    elseif ($s.practice.can_start) { Write-Host "Ready             a practice auction can be started from the home page" }
    else { Write-Host "Not ready         $($s.practice.wait)" }
    if ($p.treasury -and $p.treasury.total -eq 0 -and $p.slots.ready -eq 0 -and $p.slots.waiting -eq 0) {
      Write-Host ""
      Write-Host "The purse is empty. Send about $(Coins $p.suggested_funding) TAZ to the address from: scripts\house.ps1 address"
    }
    if ($p.last_error) { Write-Host "Last problem      $($p.last_error)" }
  }
  "address" {
    (Call "POST" "$Site/api/operator/house").address
  }
  default { throw "Unknown command '$Command'. Use status or address." }
}
