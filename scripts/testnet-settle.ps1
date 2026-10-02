# Proves the core of Dark Vault on the real Zcash testnet:
# two shielded deposits into a vault, then ONE shielded transaction that pays a
# "seller" and returns money to both "bidders", leaving the vault empty.
#
# Needs two signers running:
#   - the Dark Vault signer (this repository), on port 8082
#   - a funded testnet wallet to bid from: the Shielded Quest signer, on port 8081
#
# Everything paid out goes back to the bidding wallet, so the test costs only
# network fees (about 0.0003 TAZ).
#
#   powershell -ExecutionPolicy Bypass -File scripts\testnet-settle.ps1

param(
  [string]$Vault = "http://127.0.0.1:8082",
  [string]$Bidder = "http://127.0.0.1:8081",
  [long]$DepositA = 300000,   # the winning bidder deposits 0.003 TAZ
  [long]$DepositB = 200000,   # the other bidder deposits 0.002 TAZ
  [long]$Price = 200000       # the winner pays the second price
)

$ErrorActionPreference = "Stop"

function Call($method, $url, $body) {
  try {
    if ($null -eq $body) { return Invoke-RestMethod -Method $method -Uri $url -TimeoutSec 900 }
    return Invoke-RestMethod -Method $method -Uri $url -TimeoutSec 900 -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 8)
  } catch {
    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }
    throw "$method $url failed: $detail"
  }
}

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }

Step "Checking both signers"
$status = Call Get "$Vault/status"
Write-Host "vault signer: scanned $($status.scanned_height), tip $($status.chain_tip)"
if ($status.scanned_height -eq 0) { throw "The vault signer has not finished its first sync yet. Wait for a 'synced to' line and run this again." }
$wallet = Call Get "$Bidder/payments"
$need = $DepositA + $DepositB + 40000
Write-Host "bidding wallet: $($wallet.balance_spendable_zatoshis) zat spendable (this test needs $need)"
if ($wallet.balance_spendable_zatoshis -lt $need) { throw "The bidding wallet needs at least $need spendable zatoshis. Get testnet coins from a faucet first." }

Step "Opening a vault (one account per auction)"
$v = Call Post "$Vault/vaults"
$id = $v.vault_id
Write-Host "vault $id, birthday $($v.birthday_height)"

Step "One deposit address per bid"
$addrA = (Call Post "$Vault/vaults/$id/addresses").address
$addrB = (Call Post "$Vault/vaults/$id/addresses").address
if ($addrA -eq $addrB) { throw "The two deposit addresses are the same. They must differ." }
Write-Host "bid A -> $($addrA.Substring(0, 24))..."
Write-Host "bid B -> $($addrB.Substring(0, 24))..."

Step "Deposit A: $DepositA zat (shielded, no memo)"
$txA = (Call Post "$Bidder/send" @{ to = $addrA; zatoshis = $DepositA }).txid
Write-Host "sent in $txA"

Step "Waiting until the bidding wallet can spend again, then deposit B"
$deadline = (Get-Date).AddMinutes(20)
while ($true) {
  $wallet = Call Get "$Bidder/payments"
  if ($wallet.balance_spendable_zatoshis -ge ($DepositB + 20000)) { break }
  if ((Get-Date) -gt $deadline) { throw "The bidding wallet's change did not confirm in 20 minutes." }
  Write-Host "  spendable $($wallet.balance_spendable_zatoshis) zat; waiting for change to confirm..."
  Start-Sleep -Seconds 30
}
$txB = (Call Post "$Bidder/send" @{ to = $addrB; zatoshis = $DepositB }).txid
Write-Host "sent in $txB"

Step "Waiting for both deposits to confirm in the vault"
$total = $DepositA + $DepositB
$deadline = (Get-Date).AddMinutes(45)
while ($true) {
  $info = Call Get "$Vault/vaults/$id"
  $line = ($info.deposits | ForEach-Object { "$($_.value_zatoshis) zat, $($_.confirmations) conf, $($_.pool)" }) -join " | "
  Write-Host "  total $($info.balance_total_zatoshis), spendable $($info.balance_spendable_zatoshis) of $total  [$line]"
  if ($info.balance_spendable_zatoshis -eq $total -and $info.deposits.Count -eq 2) { break }
  if ((Get-Date) -gt $deadline) { throw "The deposits did not become spendable in 45 minutes." }
  Start-Sleep -Seconds 30
}

Step "Checking each deposit is matched to its own address"
$dA = $info.deposits | Where-Object { $_.to_address -eq $addrA }
$dB = $info.deposits | Where-Object { $_.to_address -eq $addrB }
if (-not $dA -or $dA.value_zatoshis -ne $DepositA) { throw "Deposit A was not found at its address." }
if (-not $dB -or $dB.value_zatoshis -ne $DepositB) { throw "Deposit B was not found at its address." }
Write-Host "matched: A = $($dA.value_zatoshis) zat, B = $($dB.value_zatoshis) zat"

Step "The signer refuses a settlement that doesn't add up"
$seller = (Call Post "$Bidder/address").address
$refundA = (Call Post "$Bidder/address").address
$refundB = (Call Post "$Bidder/address").address
$refused = $false
try {
  Call Post "$Vault/vaults/$id/settle" @{ payments = @(@{ to = $seller; zatoshis = $total - 1; pays_fee = $true }) } | Out-Null
} catch { $refused = $true; Write-Host "refused, as it should be: $_" }
if (-not $refused) { throw "A settlement that left money behind was accepted. It must be refused." }

Step "Settling: one transaction pays the seller and returns the rest"
$payments = @(
  @{ to = $seller;  zatoshis = $Price;              memo = "Dark Vault test: sale proceeds"; pays_fee = $true },
  @{ to = $refundA; zatoshis = $DepositA - $Price;  memo = "Dark Vault test: deposit above the price"; pays_fee = $true },
  @{ to = $refundB; zatoshis = $DepositB;           memo = "Dark Vault test: deposit returned"; pays_fee = $true }
)
$s = Call Post "$Vault/vaults/$id/settle" @{ payments = $payments }
Write-Host "settlement $($s.txid), fee $($s.fee_zatoshis) zat"
$s.payments | ForEach-Object { Write-Host "  pays $($_.zatoshis) zat to $($_.to.Substring(0, 24))..." }

Step "A second settlement is refused"
$refused = $false
try { Call Post "$Vault/vaults/$id/settle" @{ payments = $payments } | Out-Null } catch { $refused = $true; Write-Host "refused, as it should be" }
if (-not $refused) { throw "The vault settled twice. It must settle once." }

Step "Waiting for the settlement to be mined"
$deadline = (Get-Date).AddMinutes(20)
while ($true) {
  $info = Call Get "$Vault/vaults/$id"
  Write-Host "  settlement is $($info.settlement.status); vault holds $($info.balance_total_zatoshis) zat"
  if ($info.settlement.status -eq "mined") { break }
  if ($info.settlement.status -eq "expired") { throw "The settlement expired without being mined." }
  if ((Get-Date) -gt $deadline) { throw "The settlement was not mined in 20 minutes." }
  Start-Sleep -Seconds 30
}
if ($info.balance_total_zatoshis -ne 0) { throw "The vault still holds $($info.balance_total_zatoshis) zat. It should be empty." }

Step "PASS"
Write-Host "Two shielded deposits, one shielded settlement, vault empty." -ForegroundColor Green
Write-Host "Settlement transaction: $($s.txid)"
Write-Host "Paid out $(( $s.payments | Measure-Object -Property zatoshis -Sum ).Sum) zat + $($s.fee_zatoshis) zat fee = $total zat deposited."
