// The Vault Guide: a scripted helper that runs entirely in the browser.
//
// It is not an AI. It has prepared answers to common questions about Dark
// Vault, matched by keywords, and it knows which page it is on. Nothing typed
// into it is sent anywhere: there is no request in this file.

export type GuidePage = "home" | "dashboard" | "auctions" | "auction" | "sell" | "orders" | "sale" | "settlement" | "deal" | "ledger";

export interface Reply {
  text: string;
  /** Suggested next questions (ids). */
  next?: string[];
  /** Buttons: a page to go to, or something to open on this page. */
  actions?: { label: string; href?: string; event?: string }[];
}

interface Intent {
  id: string;
  /** Shown as a suggested question. */
  q: string;
  /** Keyword phrases, lower case. Phrases of several words count for more. */
  keys: string[];
  reply: Reply;
}

const WALLET = { label: "Open The Wallet", event: "dv-wallet-open" };
const AUCTIONS = { label: "See The Auctions", href: "/auctions" };
const SELL = { label: "Sell Something", href: "/sell" };
const STORY = { label: "Watch How It Works", href: "/#story" };
const WHO = { label: "See Who Can See What", href: "/#privacy" };
const MOVE = { label: "Open Move To Another Browser", href: "/dashboard#move" };
const LEDGER = { label: "Open The Ledger", href: "/ledger" };
const SETTLEMENT = { label: "Open Settlement", href: "/settlement" };
const NEW_DEAL = { label: "Create A Deal", href: "/settlement/new" };
const ORDERS = { label: "Open Order Flow", href: "/orders" };
const NEW_SALE = { label: "Start A Sale", href: "/orders/new" };

const INTENTS: Intent[] = [
  {
    id: "hello",
    q: "Hello",
    keys: ["hello", "hi", "hey", "good morning", "good evening", "thanks", "thank you"],
    reply: {
      text: "Hello. Ask me how Dark Vault works, or pick one of these.",
      next: ["what", "bid", "practice", "sees"],
    },
  },
  {
    id: "what",
    q: "What is Dark Vault?",
    keys: ["dark vault", "what is this", "what is dark vault", "what does this do", "this site", "this app", "sealed bid auction"],
    reply: {
      text:
        "Dark Vault is three private markets on Zcash, built on one shielded escrow.\n\nAuctions: one lot goes to the highest sealed bid.\nOrder Flow: many identical units go to the highest sealed orders.\nSettlement: two people settle a price they already agreed.\n\nIn all three the price can be public and the people never are: every payment is shielded, so nobody watching the chain can see who paid, how much or to whom.",
      next: ["bid", "orders", "deal"],
      actions: [STORY],
    },
  },
  {
    id: "bid",
    q: "How do I place a bid?",
    keys: ["place a bid", "how do i bid", "bid", "bidding", "make a bid", "seal", "sealed bid", "start"],
    reply: {
      text:
        "1. Open an auction and type your bid. It can't be below the reserve.\n2. Your browser seals it and locks it in time. The amount is never sent in a form anyone can read.\n3. The page gives you a deposit address made for that one bid. Send your bid plus the bond from a shielded balance.\n4. That is all. When bidding closes the bids open by themselves: you don't have to come back.\n\nKeep the ticket file the page offers you. It is your own record of the bid.",
      next: ["deposit", "timelock", "ticket"],
      actions: [AUCTIONS],
    },
  },
  {
    id: "deposit",
    q: "How much do I deposit?",
    keys: ["deposit", "how much do i send", "how much do i deposit", "bigger", "more than my bid", "why do i send", "hide my bid", "round amount", "bid plus", "highest bid", "maximum bid"],
    reply: {
      text:
        "Your bid plus the bond. Nobody can bid below the reserve, and there is no highest bid.\n\nThe chain shows nothing, because the payment is shielded. This site does see deposits arrive, so it can work your bid out from an exact deposit. If you mind, tick \"Hide My Bid From This Site\" on the bid form: you then send a larger, round amount, and the site learns only the most you can have bid.\n\nIf you win you pay what you bid, and the bond comes back after the handover. If you lose, all of it comes back.",
      next: ["win", "lose", "bond"],
    },
  },
  {
    id: "timelock",
    q: "Can anyone open my bid early?",
    keys: ["open my bid", "early", "time lock", "timelock", "time locked", "locked in time", "drand", "peek", "see my bid", "before the close"],
    reply: {
      text:
        "No, and that includes this site. Your browser encrypts the bid to a moment just after bidding ends, using the drand network: about twenty independent organisations that sign a new round every three seconds. The signature of that round is the only key, and it does not exist until the round arrives.\n\nThe lock is as trustworthy as drand. It would take a threshold of its members colluding to open a bid early.\n\nOne thing the lock can't hide: the site sees how much you deposit. Tick \"Hide My Bid From This Site\" on the bid form if that matters to you.",
      next: ["sees", "proof", "limits"],
    },
  },
  {
    id: "win",
    q: "What happens if I win?",
    keys: ["if i win", "i won", "win", "winner", "winning", "what do i pay", "pay"],
    reply: {
      text:
        "You pay exactly what you bid, nothing more. One shielded transaction returns the rest of your deposit and moves the price into the auction's vault, where it is held for the seller.\n\nThen comes the handover. For a digital lot, the key arrives in your browser. For a physical lot, you send your shipping details, sealed so only the seller can read them. The seller is paid only after the handover.",
      next: ["deliver", "dispute", "proof"],
    },
  },
  {
    id: "lose",
    q: "What happens if I lose?",
    keys: ["if i lose", "i lost", "lose", "lost", "refund", "get my money back", "money back", "returned"],
    reply: {
      text:
        "Your whole deposit comes back to the refund address you gave, in the same shielded transaction that settles the auction. Your bid is never shown to anyone.\n\nYou can still check the result: the page verifies a proof that the winning bid really was the highest.",
      next: ["proof", "ticket"],
    },
  },
  {
    id: "proof",
    q: "How do I know the highest bid won?",
    keys: ["proof", "prove", "verify", "cheat", "fair", "trust", "how do i know", "highest bid won", "rigged", "honest"],
    reply: {
      text:
        "Every result comes with a proof, and your browser checks it. It shows that the winning bid holds exactly the price, and that every other bid that counted was no higher, without showing what those bids were.\n\nYou don't have to trust the page either: the same check runs from a terminal with \"npm run verify\". The site also signs a receipt for every bid, so a bidder whose bid went missing can show it.",
      next: ["sees", "limits"],
    },
  },
  {
    id: "sees",
    q: "What can this site see?",
    keys: ["site see", "can the site", "who can see", "what do you see", "operator", "server see", "privacy", "private", "my bid private", "is my bid", "leak", "what is hidden", "who learns"],
    reply: {
      text:
        "While bidding is open: commitments, locked bids it can't open, refund addresses, and the size of each deposit. A deposit is at least the bid plus the bond, so it tells the site the most that bidder can have bid. A bidder who ticks \"Hide My Bid\" sends a larger, round amount.\n\nAfter the close: the amounts of the bids that were funded in full. It has to learn those to decide the auction. They are never shown to anyone else.\n\nSomeone watching the chain sees nothing at either moment.",
      next: ["chain", "limits", "timelock"],
      actions: [WHO],
    },
  },
  {
    id: "chain",
    q: "What does the chain show?",
    keys: ["chain", "blockchain", "on chain", "explorer", "public ledger", "shielded", "transaction"],
    reply: {
      text:
        "Nothing about the auction. Deposits, refunds and the payout are all shielded Zcash transactions, and every bid has its own deposit address. An observer can't see who bid, how much, who won, what was paid, or even that a transaction belongs to an auction.",
      next: ["sees", "deposit"],
    },
  },
  {
    id: "practice",
    q: "Can I try it without coins?",
    keys: ["practice", "try", "no coins", "without coins", "test coins", "demo", "faucet", "taz", "free"],
    reply: {
      text:
        "Yes. Start a practice auction: the site lists a small lot, automated house bidders bid on it, and a practice wallet gives you testnet coins to bid against them. It takes a few minutes and everything on chain is real: shielded deposits, a time-locked bid and a proof of the result.\n\nA practice wallet is held by the site and only works in practice auctions. Real auctions are bid on from your own wallet.",
      next: ["bid", "wallet"],
      actions: [{ label: "Go To Practice", href: "/auctions" }],
    },
  },
  {
    id: "wallet",
    q: "Do I have to connect a wallet?",
    keys: ["connect", "wallet", "connect wallet", "metamask", "account", "an account", "need an account", "sign in", "login", "log in", "sign up", "register"],
    reply: {
      text:
        "No. There are no accounts. \"Connect Wallet\" only saves a refund address in this browser so it is filled in when you bid. Nothing is sent to the site when you connect.\n\nYou pay each deposit from your own Zcash wallet app. The most private choice is a fresh refund address for every bid, because one saved address lets the site tell that your bids belong together.",
      next: ["bid", "ticket"],
      actions: [WALLET],
    },
  },
  {
    id: "ticket",
    q: "What is a bid ticket?",
    keys: ["ticket", "my ticket", "lost my ticket", "lost my bid", "file", "receipt"],
    reply: {
      text:
        "A ticket is your own record of a sealed bid: the amount, the secret that opens it and the site's signed receipt. It lives in this browser only.\n\nSave the ticket file when you bid. It restores the bid in another browser, and it is what unlocks a lot you win. To carry everything at once, use Move To Another Browser on the dashboard. A file is never uploaded.",
      next: ["move", "wallet", "win"],
      actions: [WALLET],
    },
  },
  {
    id: "move",
    q: "How do I move to another browser?",
    keys: ["another browser", "another device", "new device", "new browser", "change browser", "move", "backup", "back up", "restore", "phone", "laptop", "account", "log in", "login", "sign up", "sign in", "cleared", "passphrase", "vault file"],
    reply: {
      text:
        "Dark Vault has no accounts, on purpose: an account would let the site tie all your bids together. Your bids, seller keys and invites live in this browser.\n\nTo move them, open the dashboard and use Move To Another Browser. Save My Vault File puts everything in one file. Give it a passphrase and it is encrypted before it leaves the page. In the other browser, open the same card and choose Restore From A File.\n\nNothing is uploaded, and restoring never replaces what a browser already holds. If you clear this browser's data without a file, the site can't bring your bids back. Deposits still return to the refund addresses you gave, but a lot you win can't be unlocked without its ticket.",
      next: ["ticket", "wallet"],
      actions: [MOVE],
    },
  },
  {
    id: "settle",
    q: "How does an auction settle?",
    keys: ["auction settle", "settles", "settled", "payout", "paid out", "ledger", "how is the seller paid", "one transaction", "refunds"],
    reply: {
      text:
        "In one shielded transaction. When the bids have opened and the result is proved, the site sends a single payment that returns every deposit that did not win and sets the price aside. The chain shows no amounts and no addresses.\n\nThe price is then held until the lot is handed over. When the winner confirms, or their time to complain runs out, the seller is paid and both bonds go back.\n\nThe Ledger lists every closed auction: the price, whether the payout has reached a block, and a link to check the proof.",
      next: ["proof", "deliver", "fees"],
      actions: [LEDGER],
    },
  },
  {
    id: "deal",
    q: "What is Settlement?",
    keys: ["settlement", "settle a deal", "deal", "deals", "private deal", "escrow", "fixed price", "no bidding", "agreed a price", "already agreed", "otc", "pay someone", "trade with", "two people", "buyer and seller"],
    reply: {
      text:
        "Settlement is the second market here. It is for two people who have already agreed a price: no bidding.\n\nThe seller writes the terms and the price. The terms are encrypted in the seller's browser, and one private link carries the key to the buyer. The buyer pays the price into a shielded escrow. Then comes the handover: a file unlocks, a parcel ships or the work is done. When the buyer confirms, the price is released to the seller.\n\nBoth sides put down a bond, so neither can walk away for free. The chain shows nothing. The site knows the price, because it holds it, but can't read the terms.",
      next: ["dealmake", "dealpay", "dealsees"],
      actions: [SETTLEMENT],
    },
  },
  {
    id: "dealmake",
    q: "How do I create a deal?",
    keys: ["create a deal", "make a deal", "new deal", "start a deal", "deal link", "send the buyer", "sell to one person", "seller link"],
    reply: {
      text:
        "1. Open Settlement and press Create A Deal.\n2. Write what the deal is for and the terms you agreed, set the price, and say what is handed over: a file or code, a parcel, or work you will do.\n3. Fund your bond. The deal opens for payment when it is in a block.\n4. Send the buyer the deal link. Keep the seller link for yourself: you need it to hand over and to be paid.\n\nThe offer stands for as long as you choose. If nobody pays in that time, the deal closes and your bond comes back.",
      next: ["dealpay", "bond", "dealsees"],
      actions: [NEW_DEAL],
    },
  },
  {
    id: "dealpay",
    q: "How do I pay for a deal?",
    keys: ["pay for a deal", "accept a deal", "accept this deal", "accept", "i am the buyer", "buyer", "pay the seller", "payment address", "how do i pay", "deal payment"],
    reply: {
      text:
        "Open the deal link the seller sent you. Read the terms: your browser opens them with the key in the link.\n\nIf they are what you agreed, press Accept This Deal and give a shielded refund address. The page shows a payment address made for you alone. Send the price plus your bond, with no memo.\n\nThe money goes into escrow, not to the seller. It is released when you confirm the handover, or when your time to complain runs out. If the seller doesn't hand over in time, all of it comes back to you with the seller's bond on top.",
      next: ["bond", "dispute", "dealsees"],
    },
  },
  {
    id: "dealsees",
    q: "Who can see a deal?",
    keys: ["who can see a deal", "see a deal", "deal private", "is a deal private", "deal public", "price on the ledger", "public ledger", "show the price"],
    reply: {
      text:
        "The chain: nothing. Every payment is shielded.\n\nThe public: nothing, unless the seller ticked Show The Price On The Public Ledger. Then, once the deal is over, the ledger shows that a deal of that price was settled, and nothing else.\n\nThis site: the price, the bonds and the time limits, because it runs the escrow, and it sees the payment arrive. It can't read the terms or the item.\n\nOne exception, by the buyer's choice: to open a dispute, their browser gives the operator the key to the terms.",
      next: ["deal", "dispute", "sees"],
      actions: [LEDGER],
    },
  },
  {
    id: "orders",
    q: "What is Order Flow?",
    keys: ["order flow", "batch sale", "batch", "many units", "several units", "units", "multiple units", "identical", "licence keys", "license keys", "invite codes", "tickets", "sell many", "sell several", "more than one", "third market", "three markets"],
    reply: {
      text:
        "Order Flow is the third market here. One seller offers several identical units at once: licence keys, invite codes, tickets.\n\nBuyers send sealed orders, one order for one unit, locked in time like a bid. When the sale closes the highest orders win a unit each, and each buyer pays exactly what they offered.\n\nThe public result is how many units sold and the lowest order that won. A proof shows the right orders won. What every other order offered stays hidden.",
      next: ["order", "orderpay", "ordersees"],
      actions: [ORDERS],
    },
  },
  {
    id: "order",
    q: "How do I place an order?",
    keys: ["place an order", "how do i order", "order", "orders", "buy a unit", "one unit", "two units", "want two"],
    reply: {
      text:
        "1. Open a sale and type what you offer for one unit. It can't be below the lowest price.\n2. Your browser seals it and locks it in time.\n3. The page gives you a deposit address made for that one order. Send your order plus the bond from a shielded balance.\n4. That is all. Orders open by themselves at the close.\n\nWant two units? Place two orders. If your order wins, the seller's browser sends you the key to your unit, and it unlocks in yours.",
      next: ["orderpay", "deposit", "ordersees"],
      actions: [ORDERS],
    },
  },
  {
    id: "orderpay",
    q: "What do the winners of a sale pay?",
    keys: ["winners pay", "what do i pay in a sale", "pay what you offered", "pay what i offered", "lowest winning", "same price", "the same for everyone", "price the same", "same for everyone", "uniform price", "clearing price", "who wins a sale", "highest orders", "equal orders", "tie"],
    reply: {
      text:
        "Each winner pays exactly what they offered. The highest orders win a unit each; of two equal orders, the one placed first.\n\nNobody pays a price set by someone else's order. So a seller can't place an order of their own to push your price up, and you can check what you pay yourself: it is the number you sealed.\n\nThe lowest order that won is published, so everyone can see what a unit went for at the least.",
      next: ["order", "proof", "ordersees"],
    },
  },
  {
    id: "ordersees",
    q: "Who can see an order?",
    keys: ["who can see an order", "see an order", "an order", "my order", "see my order", "order private", "is an order private", "sale private", "who sees a sale", "hide my order"],
    reply: {
      text:
        "The chain: nothing. Every deposit is shielded.\n\nThe public: how many units sold and the lowest order that won. Not who ordered, and not what any other order offered.\n\nThis site: no order until the close, because they are locked in time. After it, the orders that counted, because it has to pick the winners. Tick Hide My Order From This Site and your deposit doesn't give your order away before then either.\n\nThe seller: what each sold unit went for, because that is what they are paid.",
      next: ["orders", "timelock", "sees"],
      actions: [WHO],
    },
  },
  {
    id: "ordersell",
    q: "How do I start a sale?",
    keys: ["start a sale", "new sale", "create a sale", "sell units", "sell keys", "sell codes", "one per line", "list units"],
    reply: {
      text:
        "1. Open Order Flow and press Start A Sale.\n2. Write what you are selling, then the units, one per line: each line is what one buyer receives. 2 to 20 units.\n3. Set the lowest price for one unit, and how long orders are taken.\n4. Fund your bond: one bond per unit, in one payment. Orders open when it is in a block.\n\nKeep your seller link. After the close, open it and your browser sends every buyer the key to their unit. You are paid for each unit once its buyer has it. Your bond for any unit that doesn't sell comes straight back.",
      next: ["orderpay", "bond", "deliver"],
      actions: [NEW_SALE],
    },
  },
  {
    id: "sell",
    q: "How do I sell something?",
    keys: ["sell", "seller", "list", "list a lot", "listing", "auction my", "create an auction", "reserve"],
    reply: {
      text:
        "Describe the lot, set a reserve and an end time, and give a shielded payout address. No account. There is no highest bid.\n\nYou put down a bond first, and bidding opens when it arrives. You get a secret seller link: keep it, because it is the only way back to your auction. Share the bidder link or its QR code.\n\nYou are paid after the lot has been handed over.",
      next: ["private", "bond", "deliver"],
      actions: [SELL],
    },
  },
  {
    id: "private",
    q: "What is a private auction?",
    keys: ["private auction", "invite", "invite only", "invitation", "hidden auction", "unlisted", "qr", "qr code", "share"],
    reply: {
      text:
        "An auction only invited people can see. It is listed nowhere, and its title and description are encrypted in the seller's browser, so even this site can't read what is for sale.\n\nThe key travels in the invite link, in the part after the #, which browsers never send to a server. Anyone with the link or its QR code can get in and can pass it on.",
      next: ["sell", "sees"],
    },
  },
  {
    id: "bond",
    q: "What are the bonds for?",
    keys: ["bond", "bonds", "stake", "something to lose", "penalty", "forfeit"],
    reply: {
      text:
        "Both sides have something to lose. The seller puts down a bond before bidding opens, and every deposit includes one.\n\nA seller who doesn't hand the lot over, or loses a dispute, loses their bond to the winner. A winner who opens a dispute and loses it loses theirs to the seller. A seller and a winner who both do their part get their bonds back in full.",
      next: ["deliver", "dispute"],
    },
  },
  {
    id: "deliver",
    q: "How does the winner get the lot?",
    keys: ["deliver", "delivery", "handover", "hand over", "shipping", "ship", "receive the lot", "digital", "physical", "address", "get the lot"],
    reply: {
      text:
        "It depends on the lot.\n\nDigital: the seller encrypted it in their browser when listing. After the sale their browser sends the key, sealed so only the winner can open it.\n\nPhysical: the winner sends shipping details, sealed so only the seller can read them. The site can't.\n\nA promise (an hour of someone's time, naming rights): the winner tells the seller what they want, the same sealed way.\n\nThe seller is paid once the winner confirms, or when the time to object has passed.",
      next: ["dispute", "bond"],
    },
  },
  {
    id: "dispute",
    q: "What if the lot is not as described?",
    keys: ["dispute", "not as described", "scam", "fake", "wrong item", "never arrived", "did not arrive", "complain", "problem with the lot"],
    reply: {
      text:
        "The winner has a set time after the handover to open a dispute. After that the sale is final.\n\nIn a dispute the site's operator looks at what each side chooses to hand over and decides. If it goes against the seller, the price returns to the winner with the seller's bond. If it goes against the winner, the seller is paid and gets the winner's bond.\n\nIf the lot is never handed over at all, the winner is refunded without having to do anything.",
      next: ["bond", "deliver"],
    },
  },
  {
    id: "limits",
    q: "What does it not protect?",
    keys: ["limit", "limits", "not protect", "weakness", "risk", "downside", "catch", "trust the site", "custody", "custodial", "ip address"],
    reply: {
      text:
        "Said plainly:\n• After the close the site learns the funded bids, so it can decide. Nobody else does.\n• The site sees every deposit, so an exact deposit tells it the bid. A larger, round one hides it.\n• The time lock is as trustworthy as drand.\n• The site holds the deposits while an auction runs.\n• The page's code comes from the site, as with any web app. The proof and the receipts can be checked without it.\n• It runs on the Zcash testnet and is in development.",
      next: ["proof", "sees"],
      actions: [{ label: "Read The Limits", href: "/#limits" }],
    },
  },
  {
    id: "fees",
    q: "Does the site take a fee?",
    keys: ["fee", "fees", "cost", "commission", "charge", "price to use"],
    reply: {
      text:
        "No. A settlement pays out everything in the auction's vault: the price to the seller and every other deposit back to its bidder. The only cost is the Zcash network fee, and each payment carries an equal share of it.",
      next: ["win", "lose"],
    },
  },
];

const BY_ID = new Map(INTENTS.map((i) => [i.id, i]));

/** The first questions to offer, by page. */
export function suggestions(page: GuidePage, n = 4): string[] {
  const order: Record<GuidePage, string[]> = {
    home: ["what", "practice", "sees", "proof"],
    dashboard: ["practice", "bid", "move", "sell"],
    auctions: ["bid", "practice", "deposit", "private"],
    auction: ["deposit", "timelock", "win", "lose", "proof"],
    sell: ["sell", "private", "bond", "deliver"],
    orders: ["orders", "order", "orderpay", "ordersell"],
    sale: ["order", "orderpay", "deposit", "ordersees"],
    settlement: ["deal", "dealmake", "dealpay", "dealsees"],
    deal: ["dealpay", "bond", "dispute", "dealsees"],
    ledger: ["settle", "proof", "dealsees", "fees"],
  };
  return order[page].slice(0, n);
}

export const questionText = (id: string) => BY_ID.get(id)?.q ?? id;
export const replyFor = (id: string): Reply => BY_ID.get(id)?.reply ?? fallback();

export function greeting(page: GuidePage): Reply {
  const where: Record<GuidePage, string> = {
    home: "Ask me how Dark Vault works, or pick a question below.",
    dashboard: "This is your dashboard: your bids, your listings and what is open now. Ask me anything, or pick a question.",
    auctions: "These are the auctions. Open one to bid, or ask me how it works first.",
    auction: "You are on an auction page. Ask me about bidding, the deposit or what happens at the close.",
    sell: "You are listing a lot. Ask me about reserves, bonds, private auctions or delivery.",
    orders: "This is Order Flow: one seller, several identical units, sealed orders. Ask me how it works.",
    sale: "You are on a batch sale. Ask me about ordering, the deposit or what the winners pay.",
    settlement: "This is Settlement: two people settle a deal they already agreed, through a shielded escrow. Ask me how it works.",
    deal: "You are on a private deal. Ask me about paying, the bonds or what happens if something goes wrong.",
    ledger: "This is the public ledger: how every auction ended, what every sale's units went for, and each deal that chose to show its price. Ask me how settlement works or how to check a proof.",
  };
  return { text: `Hello. I am the Vault Guide. ${where[page]}` };
}

function fallback(): Reply {
  return {
    text: "I only have prepared answers, and none of them fits that. Try one of these, or use other words.",
    next: ["what", "bid", "deposit", "sees"],
  };
}

const normalize = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .trim()} `;

// Words too common to settle a match by themselves.
const WEAK = new Set(["bid", "pay", "try", "start", "file", "address", "list", "share", "free", "cost", "lost", "order", "orders", "units", "tie", "batch"]);

/** The prepared answer that fits a typed question best, or a polite shrug. */
export function match(message: string): Reply {
  const text = normalize(message);
  if (!text.trim()) return fallback();
  let best: Intent | null = null;
  let bestScore = 0;
  for (const it of INTENTS) {
    let score = 0;
    for (const k of it.keys) {
      if (text.includes(` ${k} `)) score += k.includes(" ") ? 3 : WEAK.has(k) ? 1 : 2;
      else if (!k.includes(" ") && k.length >= 5 && text.includes(k)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best && bestScore >= 2 ? best.reply : fallback();
}
