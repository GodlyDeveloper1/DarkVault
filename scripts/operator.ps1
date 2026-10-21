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
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 return AUCTION-ID
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 lost AUCTION-ID
#   powershell -ExecutionPolicy Bypass -File scripts\operator.ps1 ask AUCTION-ID -Side seller -Text "Show the receipt of posting."
#
# The desk at /operator does all of this in the browser; this is the same from a terminal.
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
# return   the winner was right about a posted item, but sends it back first:
#          the seller gives a return address, the winner posts it, then the
#          refund (with the seller's bond) follows.
# lost     a parcel lost, damaged or held in the post: the winner is refunded and
#          each side gets its own bond back.
# ask      asks one side (-Side winner or seller) for more proof, with 48 hours to
#          answer. They see it as a request from the site; silence loses.
#
# One side wins the whole dispute: there are no splits.
#
# A wrong digital key never comes here: that is decided by the keys.

param(
  [Parameter(Position = 0)][string]$Command = "list",
  [Parameter(Position = 1)][string]$AuctionId,
  [ValidateSet("winner", "seller")][string]$Side,
  [string]$Text,
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

# Always with a decimal point, whatever this computer's language settings, so an amount can be pasted into wallet.ps1.
function Coins($zat) { return ([decimal]$zat / 100000000).ToString("0.########", [System.Globalization.CultureInfo]::InvariantCulture) }

switch ($Command) {
  "list" {
    $open = (Call "GET" "$Site/api/operator/disputes" $null).disputes
    if (-not $open -or $open.Count -eq 0) { Write-Host "No open disputes."; break }
    foreach ($d in $open) {
      Write-Host ""
      Write-Host "Auction      $($d.id)"
      Write-Host "Lot          $($d.title) ($($d.lot))"
      Write-Host "Description  $($d.description)"
      if ($d.private) { Write-Host "Private      yes. Its listing is encrypted; what you see above was opened with the key the winner handed over with the complaint." }
      Write-Host "Price held   $(Coins $d.price) TAZ"
      Write-Host "Bonds        seller $(Coins $d.seller_bond) TAZ, winner $(Coins $d.buyer_bond) TAZ"
      Write-Host "Winner says  $($d.reason)"
      if ($d.seller_reply) { Write-Host "Seller says  $($d.seller_reply)" } else { Write-Host "Seller says  (no answer yet)" }
      if ($d.lot_available) { Write-Host "The delivered lot can be opened with: show $($d.id)" }
      foreach ($r in $d.requests) {
        $when = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$r.due).ToLocalTime().ToString("dd MMM HH:mm")
        if ($r.answer) { Write-Host "Proof        $($r.side): $($r.answer.text)" } else { Write-Host "Proof        $($r.side): asked, no answer yet (until $when)" }
      }
      if ($d.return) { Write-Host "Return       under way (see the desk at /operator for its stage)" }
      Write-Host "Decide by    $([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$d.decide_by).ToLocalTime().ToString("dd MMM HH:mm")) (then everyone's own money goes back)"
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
  { $_ -in "release", "refund", "return", "lost" } {
    NeedId
    Call "POST" "$Site/api/operator/disputes/$AuctionId" @{ decision = $Command } | Out-Null
    switch ($Command) {
      "release" { Write-Host "Decided: the seller wins. The price and the winner's bond go to the seller." }
      "refund" { Write-Host "Decided: the winner wins. The price comes back to them, with the seller's bond." }
      "return" { Write-Host "Decided: the winner wins, and sends the item back first. The seller has 48 hours to give a return address." }
      "lost" { Write-Host "Decided: lost in the post. The winner is refunded; each side gets its own bond back." }
    }
  }
  "ask" {
    NeedId
    if (-not $Side -or -not $Text) { throw "Say who and what: ask AUCTION-ID -Side winner|seller -Text ""what you need to see""" }
    Call "POST" "$Site/api/operator/disputes/$AuctionId/ask" @{ side = $Side; text = $Text } | Out-Null
    Write-Host "Asked the $Side for proof. They have 48 hours to answer."
  }
  default { throw "Unknown command '$Command'. Use list, show, release, refund, return, lost or ask." }
}
