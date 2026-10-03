# The operator's tool for disputes over physical lots.
#
# When a winner disputes a posted item, the price stays held until whoever runs
# the site decides. Start the web app with VAULT_OPERATOR_KEY set (24 characters
# or more), then:
#
#   $env:VAULT_OPERATOR_KEY = "<the same key>"
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 list
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 release <auction id>
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 refund <auction id>
#
# "release" pays the held price to the seller. "refund" returns it to the winner.
# Disputes over digital lots never come here: they are decided by the keys.

param(
  [Parameter(Position = 0)][string]$Command = "list",
  [Parameter(Position = 1)][string]$AuctionId,
  [string]$Site = "http://127.0.0.1:3100"
)

$ErrorActionPreference = "Stop"
$key = $env:VAULT_OPERATOR_KEY
if (-not $key -or $key.Length -lt 24) { throw "Set VAULT_OPERATOR_KEY (24 characters or more) to the key the web app was started with." }
$headers = @{ "x-operator-key" = $key }

function Call($method, $url, $body) {
  try {
    if ($null -eq $body) { return Invoke-RestMethod -Method $method -Uri $url -Headers $headers -TimeoutSec 60 }
    return Invoke-RestMethod -Method $method -Uri $url -Headers $headers -TimeoutSec 60 -ContentType "application/json" -Body ($body | ConvertTo-Json)
  } catch {
    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }
    throw "$method $url failed: $detail (a 404 here usually means the key is wrong or VAULT_OPERATOR_KEY is not set on the web app)"
  }
}

switch ($Command) {
  "list" {
    $open = (Call "GET" "$Site/api/operator/disputes" $null).disputes
    if (-not $open -or $open.Count -eq 0) { Write-Host "No open disputes."; break }
    foreach ($d in $open) {
      Write-Host ""
      Write-Host "Auction  $($d.id)"
      Write-Host "Lot      $($d.title)"
      Write-Host "Held     $($d.price) zat"
      Write-Host "Winner says: $($d.reason)"
    }
  }
  { $_ -in "release", "refund" } {
    if ($AuctionId -notmatch "^[0-9a-f]{32}$") { throw "Give the auction id (32 hex characters), from 'list'." }
    Call "POST" "$Site/api/operator/disputes/$AuctionId" @{ decision = $Command } | Out-Null
    if ($Command -eq "release") { Write-Host "Decided: the held price goes to the seller." } else { Write-Host "Decided: the held price goes back to the winner." }
  }
  default { throw "Unknown command '$Command'. Use list, release <auction id> or refund <auction id>." }
}
