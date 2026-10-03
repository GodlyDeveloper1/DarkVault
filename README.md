# Dark Vault

A sealed-bid auction house on Zcash. Bids are shielded deposits: nobody watching
the chain can see who bid, how much, who won or what was paid. The seller is paid only
after the lot has been handed over, and the site can't read the lot or the winner's address.

Built solo by [@Diaguren_Labs](https://x.com/Diaguren_Labs) for the
[Zecathon](https://thezecathon.com/) (Private Markets track). **Testnet only. In development.**

## How an auction works

1. **List.** A seller describes a lot, sets a reserve and an end time, and gives a shielded
   payout address. No account. Bidding opens when the seller's bond has arrived.
2. **Bid.** The bidder's browser seals the bid in a commitment. The server answers with a
   deposit address made for that one bid.
3. **Deposit.** The bidder sends at least their bid plus a small bond to that address from a
   shielded balance.
4. **Close and reveal.** Bidding stops, then bidders reveal their amounts.
5. **Settle.** The highest bid wins and pays **exactly what it bid**. **One shielded
   transaction** returns the winner's excess and every other deposit, and moves the price
   into the auction's escrow vault. Each payment carries an equal share of the network fee.
6. **Deliver.** The seller hands over the lot and the winner checks it; then a second shielded
   transaction pays the seller and returns both bonds. If the lot is not handed over, or a
   dispute goes against the seller, that transaction returns the price to the winner with the
   seller's bond.

## What exists so far

| Part | What it does | State |
|---|---|---|
| `signer/` | Rust service on librustzcash, the only part that holds keys. One Zcash account per auction (a "vault"), one never-reused deposit address per bid, and settlement in a single shielded transaction. | Proven on testnet (below) |
| `vault-core/` | TypeScript rules shared by the browser and the server: bid commitments, the decision (highest sealed bid wins and pays its bid), the settlement plan, and sealed delivery. 35 tests. | Done for the core |
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
| Check | The winner's browser opens the key, checks it against the hash and decrypts the lot. The winner looks at it and says whether it is what was described. | The winner confirms when it arrives. |
| Payout | Confirmed, or no complaint within the time limit: the seller is paid. Not handed over in time: the winner is refunded. | The same. |
| Wrong key | The winner hands over the bid's delivery key; the site repeats the check and refunds the winner if the key doesn't open the lot. No judgement call. | |
| Not as described | The winner hands over the key to that one lot. The price stays held; the operator opens exactly what was delivered, reads both sides and decides (`scripts/operator.ps1`). | The price stays held; the operator reads both sides and decides. |

A third kind of lot is **a promise**: something the seller will do for the winner, such as
naming rights or an hour of their time. It runs like a physical lot. Where a postal address
would go, the winner sends sealed instructions (the name they chose, say) that only the seller
can read; the seller does it, marks it done with an optional sealed note, and the winner
confirms. The same time limits, disputes and bonds apply.

How it is built:

- **Keys.** Every bid carries a public delivery key made in the bidder's browser; the private
  half stays in the ticket. A seller's keys and the lot key are derived from the manage key in
  their link. The site is never shown the manage key, only a token derived from it.
- **Escrow.** Each auction with delivery has a second vault. The first payout sends the price
  there instead of to the seller. The second payout empties it to exactly one party. Both follow
  the signer's rules below, so nothing can stay with the coordinator.
- **Time limits**, set by the seller: one for the handover, one for complaints.

### Bonds: making dishonesty cost something

Escrow alone means a cheat only fails to gain. Bonds make them lose.

- **The seller's bond** is paid into the auction's escrow vault before bidding opens (the
  listing stays hidden until it arrives, and is cancelled if it never does). Bidders see the
  amount. The minimum is 10% of the reserve; a seller can stake more.
- **The bidder's bond** rides on every bid: a bid counts only if its deposit covers the bid plus
  the bond. Losing bidders get it back at the close with the rest of their deposit.
- At the end, each bond goes back to its owner, in full, unless its owner was at fault:

| How it ended | Price | Seller's bond | Winner's bond |
|---|---|---|---|
| Delivered and confirmed, or no complaint in time | seller | seller | winner |
| Seller never handed over, sent a wrong key, or lost a dispute | winner | **winner** | winner |
| Winner opened a dispute and lost it | seller | seller | **seller** |
| Winner never said where to send a posted lot | winner | seller | **seller** |
| Operator finds nobody at fault | as decided | seller | winner |
| Lot did not sell | | seller | |

Every row pays out exactly what the escrow vault holds (`planEscrowPayout` in `vault-core`).

What this does not solve, and says so: the site can prove the right key was delivered, not
that a file is what the description promised; a dispute over a posted item needs a human; a
refund after a failed delivery is the price minus two network fee shares; and the site holds
the price while it is in escrow, as it holds deposits during bidding. A one-time code (a gift
card, a licence key) can't be proven used or unused by anyone, so for those the rule is: if the
delivered code matches the description, the sale stands. Sellers and bidders are anonymous, so
there is no reputation; the bonds are what a cheat has to lose. A seller whose lot doesn't sell
gets the bond back minus one network fee.

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
bid. List a lot at `/sell` and **keep the seller link**. Open the auction with it and send the
bond to the address shown; bidding opens when it is in a block. Place two bids from two browser
windows, fund each with its bid plus the bond, and wait: the auction closes, the browsers reveal, and one transaction
returns the losing deposit and moves the price into escrow. Open the seller link: for a
digital lot the key goes to the winner by itself and the winner's window unlocks the lot. Press
"It is what was described" there, and a second transaction pays the seller and returns both
bonds.

## Web app settings

| Variable | Default | Meaning |
|---|---|---|
| `SIGNER_URL` | `http://127.0.0.1:8082` | Where the web app finds the signer |
| `VAULT_DATA_DIR` | `vault-web/data` | Folder for auction records and encrypted lots |
| `VAULT_MIN_DURATION_SEC` | `600` | Shortest auction allowed |
| `VAULT_MIN_REVEAL_SEC` | `300` | Shortest reveal window allowed |
| `VAULT_CLOSE_GRACE_SEC` | `40` | Wait after the end time before closing, so the signer has scanned the last blocks |
| `VAULT_BOND_PERCENT` | `10` | Bonds, as a percentage of the reserve (never less than 0.0005 TAZ). `0` switches bonds off |
| `VAULT_BOND_WAIT_SEC` | `7200` | How long a new listing waits for the seller's bond before it is cancelled |
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
