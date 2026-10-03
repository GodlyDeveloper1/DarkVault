# A helper for trying Dark Vault on testnet without a wallet app: it uses a
# funded Shielded Quest signer (port 8081) as the wallet.
#
#   powershell -ExecutionPolicy Bypass -File scripts\wallet.ps1 address
#       prints a fresh shielded address (use it as a payout or refund address)
#
#   powershell -ExecutionPolicy Bypass -File scripts\wallet.ps1 send <address> <TAZ>
#       sends a shielded payment with no memo (use it to fund a bid)
#
#   powershell -ExecutionPolicy Bypass -File scripts\wallet.ps1 balance

param(
  [Parameter(Position = 0)][string]$Command = "balance",
  [Parameter(Position = 1)][string]$To,
  [Parameter(Position = 2)][string]$Amount,
  [string]$Wallet = "http://127.0.0.1:8081"
)

$ErrorActionPreference = "Stop"

function Call($method, $url, $body) {
  try {
    if ($null -eq $body) { return Invoke-RestMethod -Method $method -Uri $url -TimeoutSec 900 }
    return Invoke-RestMethod -Method $method -Uri $url -TimeoutSec 900 -ContentType "application/json" -Body ($body | ConvertTo-Json)
  } catch {
    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }
    throw "$method $url failed: $detail"
  }
}

switch ($Command) {
  "address" {
    (Call Post "$Wallet/address").address
  }
  "balance" {
    $w = Call Get "$Wallet/payments"
    "{0:N8} TAZ spendable, {1:N8} TAZ in total" -f ($w.balance_spendable_zatoshis / 1e8), ($w.balance_total_zatoshis / 1e8)
  }
  "send" {
    if (-not $To -or -not $Amount) { throw "Usage: wallet.ps1 send <address> <TAZ>" }
    $zat = [long][math]::Round([decimal]$Amount * 100000000)
    if ($zat -le 0) { throw "The amount must be more than zero." }
    Write-Host "Sending $Amount TAZ ($zat zat). Building the proof takes a moment..."
    $r = Call Post "$Wallet/send" @{ to = $To; zatoshis = $zat }
    "sent in $($r.txid)"
  }
  default { throw "Unknown command '$Command'. Use address, send or balance." }
}
