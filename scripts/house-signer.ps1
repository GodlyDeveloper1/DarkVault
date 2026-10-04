# Starts the HOUSE signer: a second copy of the signer with a wallet of its own.
# It is the purse behind practice auctions: it pays the house bidders' deposits
# and the deposits of practice wallets, and gets their refunds back.
#
#   powershell -ExecutionPolicy Bypass -File scripts\house-signer.ps1
#
# Leave it running in its own window, next to the main signer. Its wallet
# lives in signer\data-house (never commit that folder: it holds the seed).
# It listens on port 8083; the main signer stays on 8082.
#
# The web app uses it when HOUSE_SIGNER_URL=http://127.0.0.1:8083 is set
# (vault-web\.env.local). Never publish either signer's port.

$ErrorActionPreference = "Stop"
$env:SIGNER_DATA_DIR = "data-house"
$env:SIGNER_PORT = "8083"
# Both signers should wait the same number of confirmations.
if (-not $env:VAULT_MIN_CONFIRMATIONS) { $env:VAULT_MIN_CONFIRMATIONS = "3" }
Set-Location (Join-Path $PSScriptRoot "..\signer")
Write-Host "House signer: wallet in signer\data-house, port 8083, $($env:VAULT_MIN_CONFIRMATIONS) confirmations."
# It is the same program as the main signer. If that has been built, run it as it is: a second
# "cargo run" would wait for the first one's build folder. Otherwise build it first.
$exe = Join-Path (Get-Location) "target\release\vault-signer.exe"
if (Test-Path $exe) { & $exe } else { cargo run --release }
