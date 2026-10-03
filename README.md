# Dark Vault

A sealed-bid auction house on Zcash. Bids are shielded deposits: nobody watching
the chain can see who bid, how much, who won or what was paid. The seller is paid only
after the lot has been handed over, and the site can't read the lot or the winner's address.

Built solo by [@Diaguren_Labs](https://x.com/Diaguren_Labs) for the
[Zecathon](https://thezecathon.com/) (Private Markets track). **Testnet only. In development.**

## How an auction works

1. **List.** A seller describes a lot, sets a reserve and an end time, and gives a shielded
   payout address. No account.
2. **Bid.** The bidder's browser seals the bid in a commitment. The server answers with a
   deposit address made for that one bid.
3. **Deposit.** The bidder sends at least their bid to that address from a shielded balance.
4. **Close and reveal.** Bidding stops, then bidders reveal their amounts.
5. **Settle.** The highest bid wins and pays **exactly what it bid**. **One shielded
   transaction** returns the winner's excess and every other deposit, and moves the price
   into the auction's escrow vault. Each payment carries an equal share of the network fee.
6. **Deliver.** The seller hands over the lot; then a second shielded transaction pays the
   seller. If the lot is not handed over, that transaction returns the price to the winner.

## What exists so far

| Part | What it does | State |
|---|---|---|
| `signer/` | Rust service on librustzcash, the only part that holds keys. One Zcash account per auction (a "vault"), one never-reused deposit address per bid, and settlement in a single shielded transaction. | Proven on testnet (below) |
| `vault-core/` | TypeScript rules shared by the browser and the server: bid commitments, the decision (highest sealed bid wins and pays its bid), the settlement plan, and sealed delivery. 30 tests. | Done for the core |
| `vault-web/` | Next.js app: list a lot, place a sealed bid, deposit, reveal, result, delivery. The server runs the auction: it closes bidding, decides the winner from the reveals and asks the signer to settle. | Core flow works; design pass to come |
| `scripts/` | A testnet proof of the signer, a stand-in signer for development, and a small wallet helper. | |

### Delivery and escrow

The price is held until the lot has reached the winner. Seller and winner exchange sealed
envelopes through the site, which can't open them (X25519, HKDF-SHA-256, AES-256-GCM, all in
the browser; `vault-core/src/delivery.ts`).

| | Digital lot (text or a file up to 1 MB) | Physical lot |
|---|---|---|
| Listing | The seller's browser encrypts the lot. The site stores the ciphertext and a hash of the lot key. | The seller's browser publishes a public key. |
| Handover | After the sale, the seller opens their manage link and their browser seals the lot key to the winner's key. | The winner's browser seals the shipping address to the seller's key. The seller ships and says so, with an optional sealed note. |
| Check | The winner's browser opens the key, checks it against the hash and decrypts the lot. If that works it confirms by itself. | The winner confirms when it arrives. |
| Payout | Confirmed, or no complaint within the time limit: the seller is paid. Not handed over in time: the winner is refunded. | The same. |
| Dispute | The winner hands over the bid's delivery key; the site repeats the check and refunds the winner if the key doesn't open the lot. No judgement call. | The price stays held until the operator decides (`scripts/operator.ps1`). |

How it is built:

- **Keys.** Every bid carries a public delivery key made in the bidder's browser; the private
  half stays in the ticket. A seller's keys and the lot key are derived from the manage key in
  their link. The site is never shown the manage key, only a token derived from it.
- **Escrow.** Each auction with delivery has a second vault. The first payout sends the price
  there instead of to the seller. The second payout empties it to exactly one party. Both follow
  the signer's rules below, so nothing can stay with the coordinator.
- **Time limits**, set by the seller: one for the handover, one for complaints.

What this does not solve, and says so: the site can prove the right key was delivered, not
that a file is what the description promised; a dispute over a posted item needs a human; a
refund after a failed delivery is the price minus two network fee shares; and the site holds
the price while it is in escrow, as it holds deposits during bidding.

### Connect wallet, without handing over an address

On other chains, connecting a wallet gives the site a permanent address. Here that would be the
leak: one address would tie all of a bidder's auctions together. So **Connect wallet** does less:

- The browser remembers an address for refunds (optional). Pressing Connect sends nothing to the
  server; the address is sent only when a bid is placed with it.
- Deposits are paid with a standard Zcash payment request ([ZIP 321](https://zips.z.cash/zip-0321)):
  the **Pay from wallet** button and the QR code open the bidder's own wallet app with the address
  and amount filled in.
- The wallet panel lists the bids this browser holds, follows each one (deposit, result, refund),
  and backs up or restores the tickets from a file that is never uploaded.

Saving one refund address lets the site tell that a bidder's bids belong together, and the panel
says so. Pasting a fresh address for each bid avoids that.

### Rules the signer enforces on a settlement, whatever it is asked

- Every recipient is a shielded address with an Orchard receiver.
- The payments add up to **exactly** what the vault holds. Nothing stays with the coordinator.
- Every deposit is confirmed enough to spend.
- The transaction stays inside one shielded pool, so no amount shows on the public chain.
- One settlement at a time. A vault can settle again only if money arrived after the first
  (a late deposit), and the same rules apply.

## Run the tests

```
cd vault-core
npm install
npm test
```

## Run the web app

You need [Node.js](https://nodejs.org/) 22 or newer, and the signer running (next section) or
the stand-in signer.

```
cd vault-core
npm install
cd ../vault-web
npm install
npm run dev
```

Open http://127.0.0.1:3100. The app talks to the signer at `SIGNER_URL`
(default `http://127.0.0.1:8082`).

To try it with no wallet and no coins, run the stand-in signer in place of the real one. It
keeps vaults in memory, mines a pretend block every few seconds and enforces the same
settlement rules:

```
node scripts/mock-signer.mjs
```

## Prove the signer on testnet

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

## Try a whole auction on testnet

With the real signer and the web app running, and a funded Shielded Quest signer as your wallet:

```
powershell -ExecutionPolicy Bypass -File scripts\wallet.ps1 address
powershell -ExecutionPolicy Bypass -File scripts\wallet.ps1 send <deposit address> 0.004
```

`address` prints a fresh shielded address to use as a payout or refund address; `send` funds a
bid. List a lot at `/sell` and **keep the seller link**. Place two bids from two browser
windows, fund them, and wait: the auction closes, the browsers reveal, and one transaction
returns the losing deposit and moves the price into escrow. Open the seller link: for a
digital lot the key goes to the winner by itself, the winner's window unlocks the lot, and a
second transaction pays the seller.

## Web app settings

| Variable | Default | Meaning |
|---|---|---|
| `SIGNER_URL` | `http://127.0.0.1:8082` | Where the web app finds the signer |
| `VAULT_DATA_DIR` | `vault-web/data` | Folder for auction records and encrypted lots |
| `VAULT_MIN_DURATION_SEC` | `600` | Shortest auction allowed |
| `VAULT_MIN_REVEAL_SEC` | `300` | Shortest reveal window allowed |
| `VAULT_CLOSE_GRACE_SEC` | `40` | Wait after the end time before closing, so the signer has scanned the last blocks |
| `VAULT_MIN_DELIVERY_SEC` | `3600` | Shortest handover and complaint time limits a seller can set |
| `VAULT_OPERATOR_KEY` | unset | Turns on the operator's dispute routes. 24 characters or more. Keep it secret |
| `TRUST_PROXY` | off | Set to `1` behind your own reverse proxy so rate limits see visitors' addresses |

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
