# Dark Vault

A sealed-bid auction house on Zcash. Bids are shielded deposits: nobody watching
the chain can see who bid, how much, who won or what was paid. Bids are locked in time, so
not even the site can open one before bidding closes; every bidder deposits the same amount,
so a deposit gives no bid away; and each result comes with a proof, checked in the browser,
that the highest bid won, without the losing bids being shown. The seller is paid only
after the lot has been handed over, and the site can't read the lot or the winner's address.

Built solo by [@Diaguren_Labs](https://x.com/Diaguren_Labs) for the
[Zecathon](https://thezecathon.com/) (Private Markets track). **Testnet only. In development.**

## How an auction works

1. **List.** A seller describes a lot, sets a reserve, the highest bid allowed and an end
   time, and gives a shielded payout address. No account. Bidding opens when the seller's
   bond has arrived.
2. **Bid.** The bidder's browser seals the bid in a commitment and locks the amount in time:
   it is encrypted to a moment just after bidding ends. The server answers with a deposit
   address made for that one bid, and a signed receipt.
3. **Deposit.** Every bidder sends the **same amount** to their address from a shielded
   balance: the highest bid allowed plus a small bond, whatever they bid.
4. **Close and unlock.** Bidding stops, the time lock opens and the server reads the bids.
   Nobody has to come back.
5. **Settle.** The highest bid wins and pays **exactly what it bid**. The site publishes a
   **proof** of that, which every visitor's browser checks. **One shielded
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
| `vault-core/` | TypeScript rules shared by the browser and the server: bid commitments, time-locked bids, the decision (highest sealed bid wins and pays its bid), the proof of the result, signed receipts, the settlement plan, sealed delivery, and private (invite-only) listings. 70 tests. | Done for the core |
| `vault-web/` | Next.js app: list a lot, place a sealed bid, deposit, unlock, result and its proof, delivery. The server runs the auction: it closes bidding, opens the time-locked bids, decides the winner, proves the result and asks the signer to settle. | Core flow works; design pass to come |
| `scripts/` | A testnet proof of the signer, stand-ins for the signer and the time lock for development, the operator's dispute tool, the house purse's tools, and a small wallet helper. | |

### What nobody can see, and when

Three things work together so that a bid stays private from everyone, the site included, for
as long as it matters.

**Time-locked bids.** The bidder's browser encrypts the bid to a future round of the
[drand](https://drand.love/) network (the League of Entropy: about twenty independent
organisations that jointly sign a round number every three seconds). The signature of that
round is the only key, and it does not exist until the round arrives. Each auction uses the
first round signed after its end time. Encrypting needs only the network's public key and clock, which
are constants in the page's code (not something the server sends), so the browser contacts
nobody and checks for itself that the round comes after the end time. When bidding has closed, the server
fetches the round's signature from any drand relay, checks it against the network's key and
opens the bids. Bidders don't have to come back and reveal, so nobody can back out of a bid
after the close. If no relay can be reached, each bidder's browser opens its own bid from
its ticket within a backup window, as a plain commit-and-reveal auction would.

**Same-size deposits.** Deposits are shielded, so the chain shows nothing. But the site sees
each deposit arrive, and under a "deposit at least your bid" rule a deposit would tell the
site the most a bidder can have bid, while bidding is still open. So the seller sets the
highest bid allowed, and **every** bidder deposits that amount plus the bond. What a bidder
doesn't owe comes back in the settlement transaction. The cost is that bidders lock more than
they bid until the close; the seller chooses how much with the ceiling (at most 100 times the
reserve).

**A proof that the highest bid won.** A sealed bid is a Pedersen commitment on ristretto255:
`C = amount·G + blinding·H`. When the auction is decided the site publishes the result with
a proof, at `/api/auctions/ID/proof`:

- the winner's blinding, so anyone can check the winning commitment holds exactly the price;
- for every other bid that counted, a range proof that its amount is no higher than the
  price (strictly lower if it was placed before the winner, since the earlier of two equal
  bids wins), built from bit commitments and Schnorr OR-proofs.

The losing amounts are never published. No setup ceremony and no parameter download: the
only assumption is that discrete logarithms are hard in that group. A proof for 16 bids is
about 74 KB and checks in under two seconds. The auction page checks it by itself and shows
the outcome as a checklist; `npm run verify` in `vault-core` does the same from a terminal:

```
cd vault-core
npm run verify -- http://127.0.0.1:3100 AUCTION-ID
```

The server also refuses to decide an auction unless the proof it made checks out, so a bug in
the decision can't move money.

**Signed receipts.** For each bid the site signs (Ed25519) the commitment, the hash of the
time-locked bid, the bid's position on the board and the time. The browser checks the
signature and keeps the receipt, the site's key and the locked bid itself in the ticket. A bidder whose bid
is later missing from the result, moved, or marked "could not be opened" can show the receipt
and the locked bid: once the round is signed, anyone can open it and see it was valid.

| Who | While bidding is open | After the close |
|---|---|---|
| Anyone watching the chain | Nothing: all payments are shielded | Nothing |
| Other bidders, visitors | Commitments only | The price, which bids counted, and the proof. No losing amounts |
| The site | Commitments, ciphertexts it can't open, deposits that are all the same size, refund addresses | The amounts of the bids that were funded in full |
| The seller | What visitors see | What visitors see, plus their own payment |

What this does not do, said plainly:

- After the close the site does learn the funded bids' amounts. It has to, to decide. They
  are never shown to anyone else.
- The proof covers the bids that counted. A bid the site says had no deposit, too small a
  deposit, or could not be opened is outside it, because deposits are shielded and can't be
  shown to the public. The bidder concerned can tell, and holds the receipt to say so.
- The time lock is as trustworthy as drand: it fails only if a threshold of its members
  collude. The site can't open bids early on its own.
- The page's code comes from the site, as with any web app. The proof and the receipts are
  there so that the result can also be checked without the page (`npm run verify`).
- A bidder can lock nonsense in place of their bid and then choose whether to open the bid by
  hand in the backup window. They learn nothing in between: no result is published until
  the auction is decided.
- A site could still place a bid of its own. In a first-price auction that can't raise what
  the winner pays; it could only win the lot.

Auctions listed before this (SHA-256 commitments, a reveal by each bidder, a deposit that
covers the bid) keep working as they did.

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

### Private auctions: invite only, and the site can't read what is for sale

A seller can list a lot as **Private**. Three things change.

1. **It is listed nowhere.** Not on the home page, not in the API's list.
2. **The title and description are encrypted in the seller's browser** before
   they are sent, padded to one fixed size so that even their length says
   nothing. The site stores the ciphertext. It can't read what is being sold.
3. **Only invited browsers get in.** The seller is given an invite link (and
   a QR code of it) to send to the people they choose.

How the invite works:

| Thing | Where it lives | What it does |
|---|---|---|
| Invite key | In the link, after the `#`. Browsers never send that part to a server. | Everything below is derived from it, one way. |
| Access token | Sent to the site as a header. The site stores only its hash. | Lets a browser fetch the auction, bid, and fetch the proof. |
| Listing key | Stays in the browser. | Opens the title and description. |

The seller's invite key is derived from their manage key, so the seller's own
link is still all a seller has to keep. Without the invite, every request
about a private auction gets the same answer as for an auction that doesn't
exist. Someone who has the page's address but not the key sees a page that
says "This auction is private", and nothing else: the server puts nothing of
the auction into that page.

What a private auction does **not** hide, said plainly:

- The site still runs the auction, so it knows the reserve, the highest bid
  allowed, the times and how many bids there are. It can't see what the lot is.
- Anyone who has the invite link can pass it on. There is one invite per
  auction, and it can't be withdrawn.
- If the winner opens a dispute that the operator has to decide, the winner's
  browser hands the operator the key to the description (to that text and
  nothing else), because a dispute is about whether the lot matches it. The
  page says so before the winner sends it, and the key is deleted when the
  dispute is decided.
- Someone who is given the page's address without the key learns that a
  private auction exists at that address. The address is 32 random characters
  and is published nowhere.

Checking a private auction's result from the command line takes the invite
link in place of the site and id:

```
cd vault-core
npm run verify -- "http://127.0.0.1:3100/auction/AUCTION-ID#invite=KEY"
```

### Sharing an auction

Every auction page has a share card: the link, a copy button and a QR code
drawn in the browser (nothing is fetched to make it). For a public auction
it is the plain address. For a private one it is the invite link, with a
warning that the link is the invite. The seller's own link is never offered
for sharing, and the seller key is taken out of the address bar as soon as
the browser has stored it.

### Practice auctions, for visitors with no coins

A visitor who has no testnet coins, or who arrives when nothing is on sale, can still see a
whole auction. With a house purse set up, the home page offers **Start a practice auction**:

- The site lists a small digital lot (a short encrypted note). It is the seller.
- Two **house bidders** (automated) seal, time-lock and fund a bid each, the moment the
  auction opens. Their commitments are on the board before any visitor's, they are marked
  "house", and they never bid above a published amount, so a visitor who bids higher wins.
- A visitor gets a **practice wallet** with one click and bids against them. Paying a
  deposit from it is a real shielded payment from the house purse to that bid's own address.
- Everything after that is the ordinary auction: the time lock opens, the result is proven
  and checked in the browser, the losers are refunded, and the winner unlocks the lot.

What is different is said on the page: the seller and those bidders are the site, and a
practice wallet is custodial. The site holds its coins, it works only in practice auctions,
nothing can be withdrawn, and the site can tell which practice bids are one visitor's. A
practice wallet can't bid in a real auction. Practice auctions carry no bonds.

The house purse is **a second signer with its own wallet**, so its payments reach the
auction's signer as deposits from outside, exactly like a visitor's. That signer can only
pay out a whole vault at once, so the purse keeps a few small vaults ("slots") each holding
one ready-made deposit, and several deposits can be paid at the same moment. Refunds and
proceeds come back to its treasury vault, which makes new slots when the last practice
auction has paid everything back. A practice auction costs the purse about 0.0007 TAZ in
network fees (0.001 with visitors), so it needs topping up now and then; a daily limit on
practice auctions bounds what a visitor can make it spend.

Before the purse asks its signer for any payment, it writes down what the payment is for. If
the answer never comes (the server stops, the connection drops), the next pass asks the signer
what happened and carries on, so no deposit is paid twice and no vault holding coins is
forgotten. A complaint about a practice lot is not argued: the sale is undone and the price
goes back to the winner, so a dispute can't hold the purse's coins.

Set it up (once):

```
powershell -ExecutionPolicy Bypass -File scripts\house-signer.ps1
```

in its own window, next to the main signer. Put `HOUSE_SIGNER_URL=http://127.0.0.1:8083` and
a `VAULT_OPERATOR_KEY` of 24 characters or more in `vault-web\.env.local` (see
`.env.example`) and restart the web app. Then fund the purse:

```
powershell -ExecutionPolicy Bypass -File scripts\house.ps1 address
powershell -ExecutionPolicy Bypass -File scripts\wallet.ps1 send ADDRESS 0.02
powershell -ExecutionPolicy Bypass -File scripts\house.ps1 status
```

(put the address the first line prints in place of `ADDRESS`). After a few confirmations
`status` shows deposits ready, and the home page offers a practice auction.

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
  (a late deposit), and the same rules apply. The fee for such a later payout is worked out
  from what the vault holds then, not from everything it ever received.

## Run the tests

```
cd vault-core
npm install
npm test
```

The proof and time-lock tests take about fifteen seconds.

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

If the app ever answers "not found" for a page or a button that should work, stop it,
delete the `vault-web/.next` folder (it holds only build output, never auctions or coins)
and start it again.

To try it with no wallet and no coins, run the stand-in signer in place of the real one. It
keeps vaults in memory, mines a pretend block every few seconds and enforces the same
settlement rules:

```
node scripts/mock-signer.mjs
```

The web app uses the public drand network for the time lock, so it needs to reach one of
`api.drand.sh`, `drand.cloudflare.com`, `api2.drand.sh` or `api3.drand.sh` when an auction
closes (bidders' browsers never do). To develop offline there is a stand-in for that too:

```
node scripts/mock-beacon.mjs
```

and start the web app with `VAULT_TEST_BEACON_URL=http://127.0.0.1:8090`. A stand-in can sign
any round on demand, so it locks nothing; every auction that uses one shows a **TEST BEACON**
banner. Never set it on a real site.

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
powershell -ExecutionPolicy Bypass -File scripts\wallet.ps1 send DEPOSIT-ADDRESS 0.0055
```

`address` prints a fresh shielded address to use as a payout or refund address; `send` funds a
bid (put the real address in place of `DEPOSIT-ADDRESS`, and the amount the bid card asks for).
List a lot at `/sell` and **keep the seller link**. Open the auction with it and send the
bond to the address shown; bidding opens when it is in a block. Place two bids from two browser
windows, fund each with the amount its card shows (the same for both), and wait: the auction
closes, the time lock opens the bids, the page shows "Verified in your browser", and one transaction
returns the losing deposit and moves the price into escrow. Open the seller link: for a
digital lot the key goes to the winner by itself and the winner's window unlocks the lot. Press
"It is what was described" there, and a second transaction pays the seller and returns both
bonds.

## Web app settings

| Variable | Default | Meaning |
|---|---|---|
| `SIGNER_URL` | `http://127.0.0.1:8082` | Where the web app finds the signer |
| `VAULT_DATA_DIR` | `vault-web/data` | Folder for auction records, encrypted lots, published proofs and the site's receipt-signing key |
| `VAULT_MIN_DURATION_SEC` | `600` | Shortest auction allowed |
| `VAULT_MIN_REVEAL_SEC` | `300` | Shortest backup reveal window allowed (used only if the time lock can't be opened) |
| `VAULT_TEST_BEACON_URL` | unset | For tests only: a stand-in for the drand network (`scripts/mock-beacon.mjs`). It locks nothing |
| `VAULT_CLOSE_GRACE_SEC` | `40` | Wait after the end time before closing, so the signer has scanned the last blocks |
| `VAULT_BOND_PERCENT` | `10` | Bonds, as a percentage of the reserve (never less than 0.0005 TAZ). `0` switches bonds off |
| `VAULT_BOND_WAIT_SEC` | `7200` | How long a new listing waits for the seller's bond before it is cancelled |
| `VAULT_MIN_DELIVERY_SEC` | `3600` | Shortest handover and complaint time limits a seller can set |
| `VAULT_OPERATOR_KEY` | unset | Turns on the operator's routes: disputes and the house purse. 24 characters or more. Keep it secret |
| `HOUSE_SIGNER_URL` | unset | The house signer, for practice auctions and practice wallets. Unset: the site has neither |
| `VAULT_PRACTICE_DURATION_SEC` | `480` | How long a practice auction takes bids |
| `VAULT_PRACTICE_RESERVE` / `VAULT_PRACTICE_CEILING` | `100000` / twice the reserve | A practice auction's reserve and highest bid allowed, in zatoshis |
| `VAULT_PRACTICE_SLOTS` | `4` | Ready-made deposits the purse keeps for visitors, besides the house bidders' two |
| `VAULT_PRACTICE_SETTLE_WAIT_SEC` | `300` | Wait after the last practice auction before the purse makes new deposits |
| `VAULT_PRACTICE_PAY_CUTOFF_SEC` | `100` | A practice wallet pays a deposit only while this much bidding time is left, so the deposit can reach a block |
| `VAULT_PRACTICE_AUCTIONS_PER_DAY` | `30` | Practice auctions a day. Each costs the purse network fees |
| `VAULT_PRACTICE_WALLETS_PER_DAY` | `200` | Practice wallets handed out per day |
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
- Never commit `signer/data/`, `signer/data-house/` or `vault-web/data/` (all ignored). They hold
  the wallet seeds and auction records.

## Licence

[MIT](LICENSE)
