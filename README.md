# Dark Vault

A sealed-bid, second-price auction house on Zcash. Bids are shielded deposits: nobody watching
the chain can see who bid, how much, who won or what was paid.

Built solo by [@Diaguren_Labs](https://x.com/Diaguren_Labs) for the
[Zecathon](https://thezecathon.com/) (Private Markets track). **Testnet only. In development.**

## How an auction works

1. **List.** A seller describes a lot, sets a reserve and an end time, and gives a shielded
   payout address. No account.
2. **Bid.** The bidder's browser seals the bid in a commitment. The server answers with a
   deposit address made for that one bid.
3. **Deposit.** The bidder sends at least their bid to that address from a shielded balance.
4. **Close and reveal.** Bidding stops, then bidders reveal their amounts.
5. **Settle.** The highest bid wins and pays the **second-highest** bid. **One shielded
   transaction** pays the seller, returns the winner's excess and refunds every other bidder.

## What exists so far

| Part | What it does | State |
|---|---|---|
| `signer/` | Rust service on librustzcash, the only part that holds keys. One Zcash account per auction (a "vault"), one never-reused deposit address per bid, and settlement in a single shielded transaction. | Compiles; testnet proof below |
| `vault-core/` | TypeScript rules shared by the browser and the server: bid commitments, the second-price decision, and the settlement plan. 21 tests. | Done for the core |
| `vault-web/` | The web app. | Not started |

### Rules the signer enforces on a settlement, whatever it is asked

- Every recipient is a shielded address with an Orchard receiver.
- The payments add up to **exactly** what the vault holds. Nothing stays with the coordinator.
- Every deposit is confirmed enough to spend.
- The transaction stays inside one shielded pool, so no amount shows on the public chain.
- A vault settles once.

## Run the tests

```
cd vault-core
npm install
npm test
```

## Prove it on testnet

Start the signer (the first build takes 20–30 minutes; always use `--release`):

```
cd signer
$env:VAULT_MIN_CONFIRMATIONS="3"
cargo run --release
```

Then, with a funded testnet wallet to bid from (the script uses a
[Shielded Quest](https://github.com/GodlyDeveloper1/ShieldedQuest) signer on port 8081):

```
powershell -ExecutionPolicy Bypass -File scripts\testnet-settle.ps1
```

It opens a vault, makes two shielded deposits to two addresses, checks each deposit is matched
to its own address, confirms a settlement that doesn't add up is refused, settles in one
transaction, and checks the vault is empty.

## Signer settings

| Variable | Default | Meaning |
|---|---|---|
| `LIGHTWALLETD_URL` | `https://testnet.zec.rocks:443` | Light client server to sync and broadcast through |
| `SIGNER_DATA_DIR` | `data` | Folder for the wallet seed, wallet database and vault records |
| `SIGNER_PORT` | `8082` | Port to listen on |
| `SIGNER_BIND_ADDR` | `127.0.0.1` | Address to listen on. The signer has no authentication: never expose it |
| `SIGNER_BIRTHDAY` | tip − 1000 | Height to start scanning a new wallet from |
| `VAULT_MIN_CONFIRMATIONS` | 10 | Confirmations a deposit needs before it can be spent. Lower is quicker for demos and less safe against reorganisations |

## Rules for this repository

- Testnet only.
- Never commit `signer/data/` or `vault-web/data/` (both ignored). They hold the wallet seed and
  auction records.

## Licence

[MIT](LICENSE)
