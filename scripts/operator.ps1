# The operator's tool for disputes.
#
# A winner can complain that a posted item, or a digital lot, is not what was
# described. The price then stays held until whoever runs the site decides.
# Start the web app with VAULT_OPERATOR_KEY set (24 characters or more), then,
# with the same key in this window:
#
#   $env:VAULT_OPERATOR_KEY = "the same key"
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 list
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 show AUCTION-ID
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 release AUCTION-ID
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 refund AUCTION-ID
#
# list     every open dispute: the description, what the winner says, what the
#          seller answers, and the bonds at stake.
# show     for a digital lot: opens the lot that was delivered (the winner
#          handed over its key when they complained). Text is printed; a file
#          is saved in the current folder.
# release  the seller was right: the price goes to the seller, and so does the
#          winner's bond.
# refund   the winner was right: the price goes back to the winner, with the
#          seller's bond.
# Add -NoFault to release or refund when nobody is to blame (a parcel lost in
# the post, say): each side then gets its own bond back.
#
# A wrong digital key never comes here: that is decided by the keys.

param(
  [Parameter(Position = 0)][string]$Command = "list",
  [Parameter(Position = 1)][string]$AuctionId,
  [switch]$NoFault,
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
    throw "$method $url failed: $detail (a 404 here usually means the key is wrong, VAULT_OPERATOR_KEY is not set on the web app, or there is nothing to show)"
  }
}

function NeedId {
  if ($AuctionId -notmatch "^[0-9a-f]{32}$") { throw "Give the auction id (32 hex characters), from 'list'." }
}

function Coins($zat) { return ("{0:0.########}" -f ($zat / 100000000)) }

switch ($Command) {
  "list" {
    $open = (Call "GET" "$Site/api/operator/disputes" $null).disputes
    if (-not $open -or $open.Count -eq 0) { Write-Host "No open disputes."; break }
    foreach ($d in $open) {
      Write-Host ""
      Write-Host "Auction      $($d.id)"
      Write-Host "Lot          $($d.title) ($($d.lot))"
      Write-Host "Description  $($d.description)"
      Write-Host "Price held   $(Coins $d.price) TAZ"
      Write-Host "Bonds        seller $(Coins $d.seller_bond) TAZ, winner $(Coins $d.buyer_bond) TAZ"
      Write-Host "Winner says  $($d.reason)"
      if ($d.seller_reply) { Write-Host "Seller says  $($d.seller_reply)" } else { Write-Host "Seller says  (no answer yet)" }
      if ($d.lot_available) { Write-Host "The delivered lot can be opened with: show $($d.id)" }
    }
  }
  "show" {
    NeedId
    $url = "$Site/api/operator/disputes/$AuctionId/lot"
    try {
      $response = Invoke-WebRequest -Method GET -Uri $url -Headers $headers -TimeoutSec 60 -UseBasicParsing
    } catch {
      throw "Could not open the lot. It is available only for a digital lot in an open 'not as described' dispute."
    }
    if ($response.Headers["Content-Type"] -like "application/json*") {
      Write-Host "The delivered lot (text):"
      Write-Host ""
      Write-Host ($response.Content | ConvertFrom-Json).text
    } else {
      $name = "disputed-lot-$($AuctionId.Substring(0, 8)).bin"
      if ($response.Headers["Content-Disposition"] -match 'filename="([^"]+)"') { $name = "disputed-" + $Matches[1] }
      [System.IO.File]::WriteAllBytes((Join-Path (Get-Location) $name), $response.Content)
      Write-Host "The delivered lot is a file. Saved as $name in this folder. Treat it as untrusted: don't run it."
    }
  }
  { $_ -in "release", "refund" } {
    NeedId
    Call "POST" "$Site/api/operator/disputes/$AuctionId" @{ decision = $Command; no_fault = [bool]$NoFault } | Out-Null
    if ($Command -eq "release") { Write-Host "Decided: the price goes to the seller." } else { Write-Host "Decided: the price goes back to the winner." }
    if ($NoFault) { Write-Host "Nobody at fault: each side gets its own bond back." }
    elseif ($Command -eq "release") { Write-Host "The winner's bond goes to the seller." }
    else { Write-Host "The seller's bond goes to the winner." }
  }
  default { throw "Unknown command '$Command'. Use list, show, release or refund." }
}
