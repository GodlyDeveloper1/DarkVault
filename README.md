# Dark Vault

Private markets on Zcash, where the price can be public and the people never are. Three
markets on one shielded escrow: **Auctions** (one lot, sold to the highest sealed bid),
**Order Flow** (many identical units, sold to the highest sealed orders) and **Settlement**
(two people settle a price they have already agreed).

First, the auctions. A sealed-bid auction house on Zcash. Bids are shielded deposits: nobody watching
the chain can see who bid, how much, who won or what was paid. Bids are locked in time, so
not even the site can open one before bidding closes; a bidder who wants to keep the amount
from the site as well deposits a larger, round amount; and each result comes with a proof,
checked in the browser, that the highest bid won, without the losing bids being shown. The seller is paid only
after the lot has been handed over, and the site can't read the lot or the winner's address.

Built solo by [@Diaguren_Labs](https://x.com/Diaguren_Labs) for the
[Zecathon](https://thezecathon.com/) (Private Markets track). **Testnet only. In development.**

## How an auction works

1. **List.** A seller describes a lot, sets a reserve and an end time, and gives a shielded
   payout address. Nobody can bid below the reserve, and there is no highest bid. No account.
   Bidding opens when the seller's bond has arrived.
2. **Bid.** The bidder's browser seals the bid in a commitment and locks the amount in time:
   it is encrypted to a moment just after bidding ends. The server answers with a deposit
   address made for that one bid, and a signed receipt.
3. **Deposit.** The bidder sends **their bid plus a small bond** to that address from a
   shielded balance. A bidder who ticks "Hide My Bid From This Site" sends a larger, round
   amount instead, and gets back what they don't owe.
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

## How a batch sale works (the Order Flow market)

For a seller with several identical units to sell at once: licence keys, invite codes, tickets.

1. **Start a sale.** The seller writes what they are selling and the units, one per line (2 to
   20). Each unit is encrypted in the seller's browser with a key of its own. They set the
   lowest price for one unit and fund one bond per unit, in one payment. No account.
2. **Order.** A buyer's browser seals an order for **one unit** in a commitment and locks the
   amount in time, exactly as a bid is. The server answers with a deposit address made for
   that one order, and a signed receipt. Two units take two orders.
3. **Deposit.** The buyer sends **their order plus a small bond**, shielded, or a larger round
   amount if they ticked "Hide My Order From This Site".
4. **Close and unlock.** The time lock opens and the server reads the orders.
5. **Settle.** The highest orders at or above the lowest price win a unit each; of two equal
   orders, the one placed first. **Each winner pays exactly what they offered.** The site
   publishes how many units sold and the **lowest order that won**, with a proof that the
   right orders won, which every visitor's browser checks. One shielded transaction returns
   every other deposit and moves each winner's price into an escrow vault made for that unit.
6. **Hand over, unit by unit.** The seller's bond is shared out between the units that sold,
   and the seller's browser sends each buyer the key to their unit (which buyer gets which
   unit is a draw nobody outside can predict). Each unit is confirmed, disputed or timed out by itself, and its
   escrow pays out by itself: one buyer's dispute holds up nobody else's unit. The seller's bond for the units that did
   not sell comes straight back.

Why not one price for every winner? A uniform price is set by someone else's order, so an
order placed to move it (by the seller, say) changes what real buyers pay. Here, as in the
auctions, what a buyer pays is the number they sealed, and nothing anyone else does moves it.

## How a deal settles (the Settlement market)

For two people who have already agreed a price, anywhere. There is no bidding.

1. **Write it down.** The seller writes what the deal is for, the terms and the price, says
   what is handed over (a file or code, a parcel, or work they will do) and gives a shielded
   payout address. The terms are encrypted in the seller's browser. No account.
2. **Bond and link.** The seller funds a bond. The deal then opens for payment, and the seller
   sends the buyer one private link. The key to the terms is in the part after the `#`, which
   browsers never send to a server.
3. **Accept and pay.** The buyer's browser opens the terms. If they are right, the buyer
   accepts and is given a payment address made for them alone. They send **the price plus a
   bond**, shielded. The first payment in full takes the deal, at once.
4. **Escrow.** One shielded transaction moves the price and the buyer's bond into the deal's
   escrow vault, and returns anything else that was sent.
5. **Hand over and release.** The handover is the auction's: a key, an address or a request
   passes between the two browsers in sealed envelopes. When the buyer confirms, or their time
   to complain runs out, a second shielded transaction pays the seller and returns both bonds.
   If the seller doesn't hand over, the buyer gets the price back with the seller's bond.

If nobody pays while the offer stands, the deal closes and the seller's bond goes back.

## What exists so far

| Part | What it does | State |
|---|---|---|
| `signer/` | Rust service on librustzcash, the only part that holds keys. One Zcash account per auction (a "vault"), one never-reused deposit address per bid, and settlement in a single shielded transaction. | Proven on testnet (below) |
| `vault-core/` | TypeScript rules shared by the browser and the server: bid commitments, time-locked bids, the decision (highest sealed bid wins and pays its bid), the proof of the result, signed receipts, the settlement plan, sealed delivery, private (invite-only) listings, the rule for a fixed-price deal, and a batch sale's decision, payout plan and proof. 102 tests. | Done for the core |
| `vault-web/` | Next.js app. Auctions: list a lot, place a sealed bid, deposit, unlock, result and its proof, delivery. Order Flow: start a sale of several units, place a sealed order, the result and its proof, a handover per unit. Settlement: create a deal, accept and pay, escrow, handover. A public ledger of all three. The server runs the auction: it closes bidding, opens the time-locked bids, decides the winner, proves the result and asks the signer to settle. | Core flow works; design pass to come |
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

**Deposits, and hiding a bid from the site.** Deposits are shielded, so the chain shows
nothing. The rule is the one any auction has: a bid can't be below the reserve, and a bidder
deposits their bid plus the bond. There is no highest bid. But the site sees each deposit
arrive, so a deposit tells the site the most that bidder can have bid, while bidding is still
open. A bidder who minds ticks one box on the bid form and deposits the next round amount
above the bid instead (the reserve times 2, 5, 10, 20, 50, 100 and so on, plus the bond).
Many different bids lead to the same deposit, so the site learns only an upper bound. What a
bidder doesn't owe comes back in the settlement transaction. A bid counts if its deposit
covers the bid and the bond.

Earlier versions made every bidder deposit the same amount, set by the seller as a highest
bid allowed, so that no deposit said anything. That hid more, at the price of a cap on bids
and of every bidder locking that cap. The rule above replaced it. Auctions listed under the
old rule still settle by it, and the API still accepts a `ceiling` for one.

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
| The site | Commitments, ciphertexts it can't open, refund addresses, and the size of each deposit: the most that bidder can have bid (a round amount, if the bidder chose to hide the bid) | The amounts of the bids that were funded in full |
| The seller | What visitors see | What visitors see, plus their own payment |

What this does not do, said plainly:

- After the close the site does learn the funded bids' amounts. It has to, to decide. They
  are never shown to anyone else.
- While bidding is open the site sees the size of every deposit. A deposit of exactly the bid
  plus the bond tells the site that bid. Only a bidder who deposits a larger, round amount
  keeps it to an upper bound.
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
- A shielded transaction hides who paid, whom and how much. That a transaction happened, when,
  and roughly how many payments it carries (through its fee) is public, as for every Zcash
  transaction. Someone who watches the site and the chain together can guess which
  transaction settled which auction. They learn no amount and no address from it.
- A payment of 0.00005 TAZ (5,000 zatoshis) or less is ignored. The network's fee rules make
  such a note cost more to spend than it is worth, so the wallet can never move it; the site
  treats it as if it had not arrived, so that nobody can jam a payout by sending one.
- A payout waits until every deposit in its vault is confirmed. Someone who keeps sending
  payments to their own deposit address around the close can delay it, at the cost of a
  network fee each time. They can't take or redirect anyone's money.
- Seats: an auction seats 20 bidders at a time, and a sale 20 orders (`VAULT_SEATS`). A new bid
  takes a seat when it is placed and keeps it once its deposit arrives; a bid with no deposit after
  10 minutes (`VAULT_SEAT_HOLD_SEC`) gives its seat back, so nobody can fill an auction with bids
  they never fund. A bid whose seat went back is still a bid: a deposit that arrives before the
  close counts. One auction takes at most 120 bids in all (`VAULT_MAX_BIDS`), which keeps a
  payout under the signer's 200 payments. The page shows the seats left (`lib/seats.ts`). A known
  limit: someone placing unpaid bids from many internet addresses (20 bids an hour from each) can
  keep seats busy until an auction has taken 120 bids in all.
- Nobody can jam a vault with a pile of small payments. One payout spends at most 24 notes; a
  vault holding more is merged by the signer first, 20 notes at a time, each merge a payment
  from the vault to itself (`merge_step` in `signer/src/wallet.rs`). Every payment a bidder
  sends beyond their first costs 5,000 zat of network fee (ZIP 317), and that comes out of
  their own refund, handed to the signer as the prepaid part of the fee: whoever sends a
  hundred tiny payments pays to have them spent. The payout waits a few blocks for the merges.

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

The site carries the public keys as well as the envelopes: the seller's browser seals to the
key the site says is the winner's. A site that ran different code and swapped that key for
one of its own could open what was sealed to it. The site as written never does, and the
winner would see at once that their own key opens nothing; but it is the site's honesty,
not mathematics, that this rests on. (Putting each bid's delivery key on the public board,
under the signed receipt, would let both sides check it. Not built yet.)
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
  amount. It is fixed: 10% of the reserve (a deal's price, an Order Flow sale's lowest unit
  price, per unit), never under 0.0005 TAZ, the same amount every bidder puts down. Only that
  amount is ever at stake: anything a seller sends above it comes straight back.
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
| Split, by the operator or agreed between the two | shared by the percentage | seller | winner |
| The operator did not decide within the deadline | winner | seller | winner |
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

### Disputes: settled between the two, or by the operator, never left hanging

The same rules in every market (auctions, deals, and each unit of an Order Flow sale):

- **A parcel gets time to arrive.** For a physical lot the time to complain after "shipped" is
  never under a week (`VAULT_MIN_PHYSICAL_COMPLAINT_SEC`), whatever the seller chose, so a
  seller can't mark it shipped at once and be paid before the box is opened. The winner can
  press **Not Arrived Yet** once, which adds the same time again.
- **Settle it yourselves.** During a dispute the seller can offer part of the price back (1% to
  100%) and change or withdraw the offer. If the winner accepts, it ends there, with nobody at
  fault: the winner gets that share and their bond, the seller the rest and their bond.
- **Evidence photos.** Each side can add up to three photos (what arrived, the packaging, a
  receipt of posting). They are cleaned in the browser like listing photos, checked again by
  the site (`cleanJpeg`), shown only to the operator, and deleted once the payout is made. The
  page reminds people to cover any name or address label first.
- **The operator decides** on a private page, `/operator`, linked from nowhere: without the
  operator key it shows a key box and every request behind it answers "not found". It lists
  every open dispute with the complaint, the seller's answer, any standing offer, the photos,
  and (for a digital lot) the delivered item. The operator can release, refund, or **split**
  the price by a percentage; release and refund can also be marked "nobody at fault".
- **A deadline for the operator.** A dispute not decided within a week
  (`VAULT_DISPUTE_DECIDE_SEC`) ends as a refund with nobody at fault, so an absent operator
  can't trap anyone's money.
- **The site's own addresses are refused** as refund and payout addresses (found on testnet: a
  pasted escrow address sent a refund back into the escrow).

What is still true: the operator has to be trusted to judge fairly, and a physical dispute is
one side's word, and photos, against the other's.

### Listing photos: cleaned in the seller's browser

A listing (an auction, an Order Flow sale or a deal) can have up to three
photos (`vault-core/src/photos.ts`, `vault-web/lib/photoClient.ts`).

- **Every photo is redrawn in the seller's browser** on a canvas and saved again
  as a JPEG, at most 1600 pixels on its longest side and 300 KB. A redrawn
  photo carries none of what a phone writes into a photo file: GPS location,
  the device, the time. It is also turned the right way up.
- **The site checks it.** A public photo must be a JPEG with no EXIF, XMP, IPTC
  or comment block left in it (`cleanJpeg`); anything else is refused.
- **Private auctions and deals:** each photo is encrypted in the browser with
  the listing's key, padded to one fixed size, and bound to its place in the
  listing. The site stores ciphertext, serves it only to a browser that shows
  the invite's access token, never lets it into a shared cache, and the
  browser opens it. The site sees how many photos there are, nothing else.
- What a photo shows is the seller's choice: the page reminds them that
  nothing in the picture should show where they live.

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

### Settlement: private deals at a fixed price

A deal is the same record as an auction with a fixed price and no bidding, so it runs on the
same vaults, the same payout plan, the same sealed handover, the same bonds and the same
disputes. What is new is small: `decideDeal` in `vault-core` (the first payment that covers
the price and the bond takes the deal) and one step in the engine that closes a deal as soon
as that payment is in a block, instead of waiting for an end time. There is nothing to seal
and nothing to prove, because the price was fixed before either party arrived.

| Who | What they can see of a deal |
|---|---|
| Anyone watching the chain | Nothing. Every payment is shielded. |
| The public | Nothing. Or, if the seller ticked "Show The Price On The Public Ledger" and the deal completed, the price alone, added to the ledger with that day's other deals. Never which deal, the terms, the moment or the parties. |
| The site | The price, the bonds and the time limits (it runs the escrow), the two addresses it pays, and the payment arriving. Not the terms, not a digital item, not a postal address. |
| The other party | The terms and what is handed over. |

A deal is always private. It is reached only by its link, the server sends nothing about it
with the page, and every API route answers a browser without the link as it would for a deal
that doesn't exist. A locked page says the same thing for a private auction and a deal, at
either address, so even someone who has an id can't tell which it is. As with a private auction, a buyer who opens a dispute hands the operator the key to
the terms (to that text and nothing else), so the dispute can be judged.

**The ledger can't be watched to time a deal.** A deal that shows its price joins the ledger
only when it has completed and its payout is in a block, and then only when the day's batch
closes (midnight UTC; `VAULT_LEDGER_BATCH_SEC` shortens it for tests and demos). Rows carry
the price and nothing else, largest first, so two deals of one price are the same row twice.
Whether a deal may be shown is decided from its record alone, before the signer is asked
anything, so the page does the same work however many hidden deals exist.

**Honest limits.**

- The site knows a deal's price: it could not hold it otherwise. It also sees the two
  addresses it pays. It could link a seller's deals if they reuse one payout address; the
  form asks for a fresh one.
- A price on the ledger is what two parties chose to settle at. A seller can settle a deal
  with themselves (it costs them the network fees), so the ledger is a record, not an oracle.
- The site can't read a deal's terms or a digital item, with one exception that is the
  buyer's choice: to open a dispute, their browser hands the operator the key to the terms
  (and, for a digital item, the key to that item), so the dispute can be judged.
- A deal is taken by the first payment in full that has the signer's confirmations. A payment
  that lands in the short grace period after the offer's end still takes it.

### Order Flow: a sealed batch sale, pay what you offered

A batch sale is the same record as an auction with one more field (`batch`: how many units,
and the hash of each unit's key), so ordering runs on the auction's code unchanged:
commitments, the time lock, signed receipts, deposit addresses, the hide switch.

What is new, in `vault-core/src/batch.ts`:

- **The decision** (`decideBatch`): the highest orders that count win one unit each, and each
  pays its own amount. Equal orders: the earlier one on the public board.
- **The money** (`planBatch`, `planBondSplit`): one transaction pays each winner's price and
  bond into that unit's escrow and returns everything else; a second shares the seller's
  bond between the units that sold and returns the rest. Both add up to the last zatoshi.
- **The proof** (`proveBatch`, `verifyBatch`): the lowest winning order's commitment is opened,
  so anyone can check it holds the published price. Every other winner is proven to have
  offered at least that (a 40-bit range proof on the difference), and every other counted
  order no more, sharpened by position so a tie can't be turned around. If units were left
  over, every other counted order is proven to be below the lowest price. No amount but
  the published one is shown. No setup ceremony: the same range proofs as the auctions'.

On the server each sold unit becomes a record of its own, made by the site at the close, with
its own escrow vault, so the handover, the time limits, the disputes and the payout of one
unit are the auction's code too. Those records can't be asked for by id (every route answers
as if they did not exist), appear in no list, and their ids are made from a secret that
never leaves the server. Buyers and the seller reach a unit only through the sale's own
address, with their own token or key.

Which winner gets which unit is a draw nobody outside can predict, made when the sale is
decided. Handing the units out best order first would tell each buyer, by the number of their
unit, how many orders were above their own. The draw comes from the site's own key and the
sale's id, so a server that restarts in the middle of a close arrives at the same units and
the same escrows again; and a sale's result is saved before any of its money moves.

| Who | What they can see of a batch sale |
|---|---|
| Anyone watching the chain | Nothing. Every payment is shielded. |
| The public | The board of commitments, how many units sold, which commitments won, and the lowest winning order. Not what any other order offered, and not who placed any of them. |
| The site | No order until the close (they are locked in time). After it, every order that counted. It sees deposits arrive, so an exact deposit tells it the order early: the hide switch sends a round amount instead. |
| The seller | What each sold unit went for, and each buyer's delivery public key. |
| Another buyer | What the public sees, and nothing more: the units are handed out in an order nobody outside can predict, so a unit's number says nothing. One unit's key opens no other unit. |

**Honest limits.**

- The winners' prices other than the lowest are proven only to be at least the published
  price. The site and the seller know them; the public does not, by design.
- As in the auctions, the proof covers the orders that counted. An order the site says was
  unfunded or short can't be proven either way, because deposits are shielded; the buyer's
  own page tells them, and their ticket and signed receipt are their evidence.
- One order can be at most 10,000 TAZ: that is the size of the number the proof speaks about.
- The proof also says, of every counted order, on which side of the published price it fell
  (at least it, or no more than it). That follows from the result itself.
- Units are digital, 2 to 20 per sale, and a sale is public. Sharing out the seller's bond
  takes one more transaction, whose network fee comes out of the bond. Every unit's handover
  waits for that one transaction; after it, one buyer's dispute holds up nobody else's unit.
- At this site's usual bond (10%), the lowest price can be at most 100 TAZ, as for a reserve.
- A unit a buyer never opens is paid to the seller when the buyer's time to complain runs
  out, as with any digital lot.

### The ledger

`/ledger` is the public record of the three markets: how every listed auction ended (price,
payout, handover, a link to check the proof), how many units every batch sale sold and the
lowest order that won, and every finished deal whose seller chose to show its price. It is
built only from what was already public.

### Moving to another browser

There are no accounts, so a visitor's bids, payment tickets, seller keys and invites live in
their browser. The dashboard's "Move To Another Browser" saves all of it to one file and reads
such a file back. With a passphrase the file is encrypted in the browser (AES-256-GCM, key
from PBKDF2-SHA-256, 600,000 rounds). Nothing is uploaded, and restoring only adds: it never
replaces what a browser already holds.

A file can come from anyone, so nothing in one is trusted. A ticket's payment address is
never shown: the page shows the address the site made for that bid or payment, and warns if
the site has none. A seller key, from a file or from a link, is used only once the site
confirms it is that record's key, and never replaces one already held.

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

The proof and time-lock tests take about half a minute.

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

## Run it with Docker

One command starts the signer, the house signer (practice auctions) and the web
app. Testnet only.

```
copy .env.example .env        (then set VAULT_OPERATOR_KEY in .env)
docker compose up --build
```

The site is then at http://127.0.0.1:3100. The first build takes 20 to 40
minutes, because the signer compiles Zcash's proving code; later builds take
seconds. Each signer makes a wallet of its own on first start and syncs from
near the chain tip. Practice auctions start once the house purse holds testnet
coins: `scripts\house.ps1 address` gives an address to fund it (set
`VAULT_OPERATOR_KEY` in your shell to the same key as in `.env` first), and
`scripts\house.ps1 status` shows what it holds.

What is reachable:

- Neither signer has a published port. They sit on a private network with the
  web app, the only thing that can call them. They have no authentication:
  never add a `ports:` entry to either.
- The web app is published on 127.0.0.1 only. To host it, put a reverse proxy
  (with HTTPS) in front of it and set `TRUST_PROXY=1`.
- The wallets live in the `signer-data` and `house-data` volumes, the auction
  records, receipt key and evidence photos in `web-data`. Back them up, and
  never copy them anywhere public.
- Every container restarts by itself if it stops (`restart: unless-stopped`).

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
| `VAULT_LEDGER_BATCH_SEC` | `86400` | How often completed deals that show their price are added to the public ledger (batches close on a fixed clock, so a deal can't be timed). Shorter only for tests and demos |
| `VAULT_MIN_DELIVERY_SEC` | `3600` | Shortest handover and complaint time limits a seller can set |
| `VAULT_MIN_PHYSICAL_COMPLAINT_SEC` | `604800` | A physical lot's shortest time to complain after "shipped" (one week), whatever the seller chose. Shorten it only for a demo |
| `VAULT_DISPUTE_DECIDE_SEC` | `604800` | An open dispute the operator hasn't decided in this time ends as a refund with nobody at fault |
| `VAULT_OPERATOR_KEY` | unset | Turns on the operator's routes: disputes and the house purse. 24 characters or more. Keep it secret |
| `HOUSE_SIGNER_URL` | unset | The house signer, for practice auctions and practice wallets. Unset: the site has neither |
| `VAULT_PRACTICE_DURATION_SEC` | `480` | How long a practice auction takes bids |
| `VAULT_PRACTICE_RESERVE` / `VAULT_PRACTICE_CEILING` | `100000` / twice the reserve | A practice auction's reserve, and the most a practice wallet or a house bidder can bid (their deposits are ready-made amounts of that size), in zatoshis |
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
