import type { CSSProperties } from "react";
import Link from "next/link";
import type { IconType } from "react-icons";
import {
  PiArmchairBold,
  PiArrowsMergeBold,
  PiCheckBold,
  PiGavelBold,
  PiHandshakeBold,
  PiKeyBold,
  PiLockKeyBold,
  PiReceiptBold,
  PiRobotBold,
  PiScalesBold,
  PiShieldCheckBold,
  PiSquaresFourBold,
  PiStackBold,
  PiSuitcaseSimpleBold,
  PiUserMinusBold,
  PiWalletBold,
} from "react-icons/pi";
import { HOUSE } from "@/lib/house/config";
import AuctionsGrid from "./components/AuctionsGrid";
import LandMotion from "./components/LandMotion";
import PracticePanel from "./components/PracticePanel";
import WhoSees from "./components/WhoSees";

export const dynamic = "force-dynamic";

// The 3D objects are files in public/art (see CREDITS.md there). They are
// decoration: every one has an empty alt text and the page reads the same
// without them.
function Art({ name, eager, className }: { name: string; eager?: boolean; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/art/${name}.webp`}
      alt=""
      width={1200}
      height={1200}
      className={className}
      draggable={false}
      decoding="async"
      loading={eager ? "eager" : "lazy"}
    />
  );
}

/** Custom properties for one floating object: how far it moves with the pointer and where it flies when the hero scrolls away. */
const float = (d: number, fx: number, fy: number, r: number, fr: number): CSSProperties =>
  ({ "--d": d, "--fx": fx, "--fy": fy, "--r": `${r}deg`, "--fr": `${fr}deg` }) as CSSProperties;

// How an auction runs, in order. The same six steps as the README.
const STEPS = [
  {
    short: "List",
    art: "safe",
    title: "A Seller Lists A Lot.",
    text: "The seller describes the lot, sets a reserve and an end time. Nobody can bid below the reserve, and there is no highest bid. No account. Bidding opens when the seller's bond has arrived.",
  },
  {
    short: "Bid",
    art: "envelope",
    title: "You Seal A Bid.",
    text: "Your browser seals the bid in a commitment and locks the amount in time. It is encrypted to a moment just after bidding ends, so nobody can open it early, this site included.",
  },
  {
    short: "Deposit",
    art: "coin",
    title: "You Deposit Your Bid.",
    text: "You send your bid plus a small bond in one shielded payment, to an address made for that bid alone. The chain shows nothing. To keep the amount from this site too, tick one box and send a larger, round amount. What you don't owe comes back.",
  },
  {
    short: "Unlock",
    art: "clock",
    title: "The Clock Opens Every Bid.",
    text: "Bidding stops, the time lock opens and the bids are read. Nobody has to come back to reveal, so nobody can back out after the close.",
  },
  {
    short: "Settle",
    art: "trophy",
    title: "The Highest Bid Wins.",
    text: "The winner pays exactly what they bid. One shielded transaction returns the winner's excess and every other deposit. Your browser checks a proof that the highest bid won, and the losing bids are never shown.",
  },
  {
    short: "Deliver",
    art: "wallet",
    title: "The Seller Is Paid After Handover.",
    text: "The seller hands over the lot and the winner checks it. Then a second shielded transaction pays the seller and returns both bonds. If the lot never arrives, the price goes back to the winner with the seller's bond.",
  },
];

// The objects in the auction's scroll story. LandMotion moves each one between the six steps.
const ACTORS = ["safe", "envelope", "clock", "trophy", "wallet", "medal", "money-bag", "key", "padlock", "coin", "coin", "coin", "tick"];

// How a batch sale runs (the Order Flow market), in order.
const ORDER_STEPS = [
  {
    short: "List",
    art: "key",
    title: "A Seller Lists Many Units.",
    text: "One seller offers several identical units at once: licence keys, invite codes, tickets. Each unit is encrypted in the seller's browser with a key of its own, and the seller sets the lowest price for one. No account.",
  },
  {
    short: "Order",
    art: "envelope",
    title: "Buyers Seal Their Orders.",
    text: "An order is one sealed number for one unit, locked in time like a bid. You deposit your order plus a small bond in one shielded payment. Want two units? Send two orders.",
  },
  {
    short: "Unlock",
    art: "clock",
    title: "The Clock Opens Every Order.",
    text: "The sale closes, the time lock opens and every order is read at the same moment. Nobody could open one early, this site included, and nobody can back out after the close.",
  },
  {
    short: "Win",
    art: "medal",
    title: "The Highest Orders Win.",
    text: "The highest orders take a unit each, and each buyer pays exactly what they offered. The lowest order that won is published, with a proof your browser checks. What every other order offered is never shown.",
  },
  {
    short: "Hand Over",
    art: "wallet",
    title: "Each Unit Is Handed Over.",
    text: "Each price waits in an escrow of its own. The seller's browser sends every buyer the key to their unit, sealed so only they can open it. When a buyer confirms, that unit is paid for. Every other deposit has already gone home.",
  },
];
// Three keys are the units, three envelopes the orders, three coins what each buyer offered.
const ORDER_ACTORS: [id: string, art: string][] = [
  ["safe", "safe"],
  ["bag", "money-bag"],
  ["clock", "clock"],
  ["envA", "envelope"],
  ["envB", "envelope"],
  ["envC", "envelope"],
  ["padlock", "padlock"],
  ["medalA", "medal"],
  ["medalB", "medal"],
  ["medalC", "medal"],
  ["coinA", "coin"],
  ["coinB", "coin"],
  ["coinC", "coin"],
  ["wallet", "wallet"],
  ["keyA", "key"],
  ["keyB", "key"],
  ["keyC", "key"],
  ["tick", "tick"],
];

// How a private deal settles (the Settlement market), in order.
const DEAL_STEPS = [
  {
    short: "Agree",
    art: "wallet",
    title: "Two People Agree A Price.",
    text: "In a chat, on a call, wherever you like. Dark Vault is not where the price is made. It is where the deal is settled, so that neither of you has to trust the other or show the world.",
  },
  {
    short: "Seal",
    art: "envelope",
    title: "The Seller Seals The Terms.",
    text: "The seller writes what the deal is for and the price. The terms are encrypted in the seller's browser, and one private link carries the key to the buyer. This site stores them and can't read them. The deal is listed nowhere.",
  },
  {
    short: "Pay",
    art: "safe",
    title: "The Buyer Pays Into Escrow.",
    text: "The buyer reads the terms in their own browser and sends the price plus a small bond in one shielded payment. The money is held, not paid. The seller has put down a bond too. The chain shows no amount and no address.",
  },
  {
    short: "Release",
    art: "tick",
    title: "Hand Over, Then Release.",
    text: "A file unlocks, a parcel ships or the work is done. The buyer confirms, the price is released to the seller and both bonds go home. If the seller never hands over, the buyer gets the price back with the seller's bond.",
  },
  {
    short: "Ledger",
    art: "shield",
    title: "Public Only If The Seller Says So.",
    text: "A finished deal leaves no public trace. If the seller chose to show the price, the ledger says that a deal of that price was settled, added once a day with the others. Never the terms, the moment or the people.",
  },
];
// Two wallets are the two people, the envelope the terms, the two bags the two bonds.
const DEAL_ACTORS: [id: string, art: string][] = [
  ["safe", "safe"],
  ["shield", "shield"],
  ["envelope", "envelope"],
  ["bagA", "money-bag"],
  ["bagB", "money-bag"],
  ["walletA", "wallet"],
  ["walletB", "wallet"],
  ["padlock", "padlock"],
  ["key", "key"],
  ["coin", "coin"],
  ["tick", "tick"],
];

interface StoryStep {
  short: string;
  art: string;
  title: string;
  text: string;
}

/**
 * One scroll story: a pinned stage, the steps in words on one side and the
 * objects acting them out on the other. LandMotion finds it by its data-story
 * name and moves the objects between the steps. Without motion it is a plain
 * numbered list.
 */
function Story({
  name,
  id,
  head,
  label,
  steps,
  actors,
  flip,
  acts,
}: {
  name: string;
  id: string;
  head: string;
  label: string;
  steps: StoryStep[];
  actors: [id: string, art: string][];
  /** The stage on the left and the words on the right. */
  flip?: boolean;
  /** Where a story leads when it has been told: [id, address, words]. The first is the main one. */
  acts?: [id: string, href: string, words: string][];
}) {
  const links = (ids: boolean) =>
    acts?.map(([act, href, words], i) => (
      <Link className={i === 0 ? "btn primary" : "btn"} href={href} id={ids ? act : undefined} data-act={ids ? undefined : act} key={act}>
        {words}
      </Link>
    ));
  return (
    <>
      <section
        className={flip ? "story flip" : "story"}
        id={id}
        data-story={name}
        aria-label={label}
        style={{ "--steps": steps.length } as CSSProperties}
      >
        <div className="story-pin">
          <div className="shell story-in">
            <div className="story-copy">
              <h2 className="story-head">{head}</h2>
              <ol className="story-steps">
                {steps.map((s, i) => (
                  <li key={s.short} data-step-text>
                    <span className="step-art" aria-hidden="true">
                      <Art name={s.art} />
                    </span>
                    <p className="step-n">
                      Step {i + 1} Of {steps.length}
                    </p>
                    <h3 className="display">{s.title}</h3>
                    <p className="step-text">{s.text}</p>
                  </li>
                ))}
              </ol>
              <div className="rail" role="group" aria-label="Jump to a step">
                {steps.map((s, i) => (
                  <button type="button" key={s.short} data-step-go={i}>
                    <i aria-hidden="true" />
                    {s.short}
                  </button>
                ))}
              </div>
              {acts && <div className="story-acts">{links(true)}</div>}
            </div>

            <div className="scene" data-scene aria-hidden="true">
              <span className="ring" />
              {actors.map(([actor, art]) => (
                <span className={`actor a-${art}`} data-actor={actor} key={actor}>
                  <Art name={art} />
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>
      {/* On a phone the pinned screen has no room for buttons: they come after the story instead. */}
      {acts && (
        <div className="story-after">
          <div className="shell story-acts">{links(false)}</div>
        </div>
      )}
    </>
  );
}

const PROTECTIONS = [
  {
    art: "envelope",
    title: "Sealed",
    text: "Your browser sends a commitment and the bid locked in time, never an amount anyone can read.",
  },
  {
    art: "clock",
    title: "Locked in time",
    text: "Bids are encrypted to a moment after the close. Nobody can open one early, this site included, and they open by themselves: you don't have to come back.",
  },
  {
    art: "coin",
    title: "Hide your bid from the site",
    text: "A deposit is your bid plus the bond. Tick one box and you send a larger, round amount instead, so the site learns only the most you can have bid. What you don't owe comes back.",
  },
  {
    art: "tick",
    title: "Checked in your browser",
    text: "Each result comes with a proof that the highest bid won. Your browser checks it. The losing bids are never shown.",
  },
  {
    art: "shield",
    title: "Shielded",
    text: "Each bid has its own deposit address. Deposits and the payout are shielded transactions.",
  },
  {
    art: "trophy",
    title: "Highest bid wins",
    text: "The winner pays exactly what they bid. No other bid can change the price, so a fake bid can't push it up.",
  },
  {
    art: "key",
    title: "Private auctions",
    text: "A seller can make an auction invite-only. It is listed nowhere, and its title and description are encrypted in the seller's browser, so even this site can't read what is for sale. Only people with the invite link or QR code get in.",
  },
  {
    art: "money-bag",
    title: "Both sides stake a bond",
    text: "The seller puts down a bond before bidding opens, and every bid carries one. Whoever fails to deliver, or loses a dispute they opened, loses theirs to the other side. Honest parties get theirs back.",
  },
  {
    art: "wallet",
    title: "One payout",
    text: "A single transaction pays the seller and returns every other deposit. The vault ends empty.",
  },
];

// Everything Dark Vault does, market by market, so a visitor sees it is more than auctions.
const MARKET_FEATURES: {
  id: string;
  art: string;
  name: string;
  line: string;
  href: string;
  go: string;
  how: string;
  items: string[];
  practice?: string;
}[] = [
  {
    id: "features-auctions",
    art: "trophy",
    name: "Auctions",
    line: "One lot, sold to the highest sealed bid.",
    href: "/auctions",
    go: "See The Auctions",
    how: "/#story",
    items: [
      "Sealed bids, locked in time until the close. Nobody can open one early, this site included.",
      "The winner pays exactly what they bid, and a proof shows the highest bid won without showing any other.",
      "Hide your bid from the site: send a larger, round deposit and get the rest back.",
      "Private auctions: invite only, listed nowhere, the title and description encrypted in the seller's browser.",
      "Digital lots, physical items with a sealed shipping address, or a promise the seller will keep.",
      "Up to three photos per listing, cleaned in the seller's browser of where and how they were taken; encrypted in private auctions and deals.",
    ],
    practice: "Practice auctions with automated house bidders and a practice wallet the site funds.",
  },
  {
    id: "features-orders",
    art: "medal",
    name: "Order Flow",
    line: "Many identical units, sold in one sealed sale.",
    href: "/orders",
    go: "See The Sales",
    how: "/#story-orders",
    items: [
      "Sell 2 to 20 units at once: licence keys, invite codes, tickets.",
      "One sealed order per unit. The highest orders win, and each buyer pays what they offered.",
      "The lowest winning order is public, with a proof. Every other order, and who placed it, stays hidden.",
      "Units are handed out at random, so a unit number says nothing about how an order ranked.",
      "Each unit has its own escrow and its own handover: a unit unlocks only for the buyer who won it.",
    ],
  },
  {
    id: "features-settlement",
    art: "safe",
    name: "Settlement",
    line: "A price two people agreed, settled privately.",
    href: "/settlement",
    go: "Settle A Deal",
    how: "/#story-settlement",
    items: [
      "No bidding: for a price already agreed in a chat, on a call, anywhere.",
      "The terms are encrypted in the seller's browser, and one private link carries the key to the buyer.",
      "The deal is listed nowhere. This site stores it and can't read it.",
      "The buyer pays into a shielded escrow. The price is released when the handover is done.",
      "The ledger shows a finished deal only if the seller says so, added once a day with the others.",
    ],
  },
];

// What every market gets.
const SHARED_FEATURES: { icon: IconType; title: string; text: string }[] = [
  { icon: PiShieldCheckBold, title: "A Shielded Vault Each", text: "Every auction, sale and deal has its own escrow vault, and every bid its own deposit address." },
  { icon: PiScalesBold, title: "Bonds On Both Sides", text: "Seller and buyer each stake a bond. Whoever cheats or fails to deliver loses theirs to the other." },
  { icon: PiLockKeyBold, title: "Sealed Handover", text: "A digital lot or unit is encrypted for its buyer alone. Disputes and time limits protect both sides." },
  { icon: PiReceiptBold, title: "Signed Receipts", text: "The site signs every bid it accepts, so it can't later deny one or move it on the board." },
  { icon: PiArmchairBold, title: "Twenty Seats", text: "Twenty bidders at a time. A bid not funded within 10 minutes gives its seat back." },
  { icon: PiArrowsMergeBold, title: "No Jamming", text: "A pile of tiny payments is merged before a payout, at the cost of whoever sent it." },
  { icon: PiSquaresFourBold, title: "Dashboard And Ledger", text: "Your bids, sales and deals in one place, and a public ledger of what settled." },
  { icon: PiWalletBold, title: "Pay From Your Wallet", text: "Connect a wallet, or scan the code. Every payment is a shielded Zcash payment." },
  { icon: PiSuitcaseSimpleBold, title: "Move Or Clear", text: "Your tickets and keys stay in this browser. Take them to another in one encrypted file, or clear them all." },
  { icon: PiRobotBold, title: "The Vault Guide", text: "Prepared answers to the questions people ask, on every page. Not an AI." },
  { icon: PiUserMinusBold, title: "No Accounts", text: "No sign-up, no email, no name. A key in your browser is all you hold." },
  { icon: PiKeyBold, title: "Keys Kept Apart", text: "Only the signer, a separate program, holds the wallet's keys. The website never sees a seed." },
];

const LIMITS = [
  {
    title: "The site learns the funded bids after the close.",
    text: "It has to, to decide the auction. Those amounts are never shown to anyone else.",
  },
  {
    title: "The site sees every deposit.",
    text: "A deposit is at least the bid plus the bond, so it tells the site the most a bidder can have bid. Sending a larger, round amount hides the bid. Sending the exact amount does not.",
  },
  {
    title: "The time lock is as trustworthy as drand.",
    text: "It fails only if a threshold of that network's members collude. The site can't open bids early on its own.",
  },
  {
    title: "Twenty seats.",
    text: "An auction seats 20 bidders at a time, and a sale 20 orders. A bid not funded within 10 minutes gives its seat back. Someone placing unpaid bids from many internet addresses can keep seats busy until an auction has taken 120 bids in all. Extra payments into one vault are merged first, at the sender's cost.",
  },
  {
    title: "The page's code comes from the site.",
    text: "As with any web app. The proof and the signed receipts are there so a result can also be checked without the page.",
  },
  {
    title: "It runs on the Zcash testnet.",
    text: "The coins have no value. Dark Vault is in development.",
  },
];

export default function Home() {
  return (
    <main className="land">
      {/* The scroll story is switched on by a class on <html>: a script in the layout sets it before the first paint, and LandMotion sets it when the page is reached without a reload. */}
      <LandMotion />

      <section className="hero" data-hero>
        <div className="shell hero-in">
          <div className="hero-copy">
            <p className="peak">Privacy At Its Peak.</p>
            <p className="kicker">Sealed-bid auctions on shielded Zcash</p>
            <h1 className="display">
              Bid in the dark.
              <br />
              <span className="lime">The highest sealed bid wins.</span>
            </h1>
            <p className="lead">
              Every bid is a shielded deposit, sealed until bidding closes. Nobody watching the chain can see who bid, how
              much, who won or what was paid.
            </p>
            <div className="cta">
              <Link className="btn primary lg" href="/auctions">
                See the auctions
              </Link>
              <Link className="btn lg" href="/sell">
                Sell something
              </Link>
              {HOUSE.enabled && (
                <Link className="btn lg" href="/#practice-panel" id="hero-practice">
                  Try a practice auction
                </Link>
              )}
            </div>
            <div className="hero-markets" id="hero-markets">
              <span className="hero-markets-label">Not Only Auctions. One Vault, Three Markets:</span>
              <Link className="mchip" href="/auctions">
                <PiGavelBold aria-hidden="true" /> Auctions
              </Link>
              <Link className="mchip" href="/orders">
                <PiStackBold aria-hidden="true" /> Order Flow
              </Link>
              <Link className="mchip" href="/settlement">
                <PiHandshakeBold aria-hidden="true" /> Settlement
              </Link>
              <Link className="mchip plain" href="/#features">
                Everything It Does
              </Link>
            </div>
          </div>

          <div className="hero-art" aria-hidden="true">
            <span className="ring" />
            <span className="obj o-envelope" style={float(10, -260, -200, -14, -30)}>
              <span className="obj-in">
                <Art name="envelope" eager />
              </span>
            </span>
            <span className="obj o-key" style={float(26, 300, -260, 16, 50)}>
              <span className="obj-in">
                <Art name="key" eager />
              </span>
            </span>
            <span className="obj o-safe" style={float(16, 60, -40, 0, 6)}>
              <span className="obj-in">
                <Art name="safe" eager />
              </span>
            </span>
            <span className="obj o-coin" style={float(52, 340, 220, 10, 80)}>
              <span className="obj-in">
                <Art name="coin" eager />
              </span>
            </span>
            <span className="obj o-padlock" style={float(40, -320, 200, -10, -40)}>
              <span className="obj-in">
                <Art name="padlock" eager />
              </span>
            </span>
          </div>
        </div>
        <a className="scroll-cue" href="#story">
          <span>Scroll To See One Auction, Start To Finish.</span>
          <i aria-hidden="true" />
        </a>
      </section>

      <Story
        name="auction"
        id="story"
        head="How An Auction Works"
        label="How an auction works"
        steps={STEPS}
        actors={ACTORS.map((name, i) => [name === "coin" ? `coin${i}` : name, name])}
      />

      {/* The line the whole site stands behind, too big to miss. It slides past by itself. */}
      <section className="peak-band" aria-label="Privacy At Its Peak.">
        <div className="peak-run" aria-hidden="true">
          {[0, 1].map((n) => (
            <span key={n}>
              Privacy At Its Peak. <i /> Privacy At Its Peak. <i /> Privacy At Its Peak. <i />{" "}
            </span>
          ))}
        </div>
      </section>

      {/* Dark Vault is more than one market. Each has a page of its own. */}
      <section className="markets" id="markets">
        <div className="shell">
          <h2 className="display" data-reveal>
            One Vault, Three Markets
          </h2>
          <p className="lead" data-reveal>
            The same shielded escrow, the same sealed handover, three ways to trade. In all of them, the price can be public and the people never are.
            You have just seen an auction. The other two are told below, step by step.
          </p>
          <div className="markets-grid">
            <article className="slab" data-reveal data-tilt style={{ "--i": 0 } as CSSProperties}>
              <span className="slab-art" aria-hidden="true">
                <Art name="trophy" />
              </span>
              <h3>Auctions</h3>
              <p>
                Sell one lot to the highest sealed bid. Bids are locked in time until the close, the winner pays what they bid, and a proof shows the
                highest bid won without showing any other.
              </p>
              <div className="slab-acts">
                <Link className="btn primary" href="/auctions" id="market-auctions">
                  See The Auctions
                </Link>
                <Link className="btn" href="/#story" id="how-auctions">
                  How It Works
                </Link>
              </div>
            </article>
            <article className="slab" data-reveal data-tilt style={{ "--i": 1 } as CSSProperties}>
              <span className="slab-art" aria-hidden="true">
                <Art name="medal" />
              </span>
              <h3>Order Flow</h3>
              <p>
                Sell many identical units in one sealed sale. Buyers send sealed orders, the highest win a unit each, and each pays what they offered.
                The lowest winning order is public. Every other order stays hidden.
              </p>
              <div className="slab-acts">
                <Link className="btn primary" href="/orders" id="market-orders">
                  See The Sales
                </Link>
                <Link className="btn" href="/#story-orders" id="how-orders">
                  How It Works
                </Link>
              </div>
            </article>
            <article className="slab" data-reveal data-tilt style={{ "--i": 2 } as CSSProperties}>
              <span className="slab-art" aria-hidden="true">
                <Art name="safe" />
              </span>
              <h3>Settlement</h3>
              <p>
                Settle a price two people have already agreed. No bidding. The terms are encrypted in the seller&apos;s browser, the buyer pays into
                escrow, and the price is released when the handover is done.
              </p>
              <div className="slab-acts">
                <Link className="btn primary" href="/settlement" id="market-settlement">
                  Settle A Deal
                </Link>
                <Link className="btn" href="/#story-settlement" id="how-settlement">
                  How It Works
                </Link>
              </div>
            </article>
          </div>
        </div>
      </section>

      <Story
        name="orders"
        id="story-orders"
        head="Order Flow: How A Sale Works"
        label="How a batch sale works"
        steps={ORDER_STEPS}
        actors={ORDER_ACTORS}
        acts={[
          ["story-orders-go", "/orders", "See The Sales"],
          ["story-orders-new", "/orders/new", "Start A Sale"],
        ]}
        flip
      />

      <Story
        name="settlement"
        id="story-settlement"
        head="Settlement: How A Deal Settles"
        label="How a private deal settles"
        steps={DEAL_STEPS}
        actors={DEAL_ACTORS}
        acts={[
          ["story-settlement-go", "/settlement", "Settle A Deal"],
          ["story-settlement-new", "/settlement/new", "Create A Deal"],
        ]}
      />

      {/* Everything Dark Vault does, in all three markets. */}
      <section className="features" id="features">
        <div className="shell">
          <h2 className="display" data-reveal>
            Everything Dark Vault Does
          </h2>
          <p className="lead" data-reveal>
            Not only auctions. Three markets share one shielded escrow, and all of it works today on the Zcash testnet.
          </p>
          <div className="features-grid">
            {MARKET_FEATURES.map((m, i) => (
              <article className="slab feature" id={m.id} key={m.id} data-reveal data-tilt style={{ "--i": i } as CSSProperties}>
                <span className="slab-art" aria-hidden="true">
                  <Art name={m.art} />
                </span>
                <h3>{m.name}</h3>
                <p className="feature-line">{m.line}</p>
                <ul className="feature-list">
                  {[...m.items, ...(m.practice && HOUSE.enabled ? [m.practice] : [])].map((item) => (
                    <li key={item}>
                      <PiCheckBold aria-hidden="true" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <div className="slab-acts">
                  <Link className="btn primary" href={m.href}>
                    {m.go}
                  </Link>
                  <Link className="btn" href={m.how}>
                    How It Works
                  </Link>
                </div>
              </article>
            ))}
          </div>
          <h3 className="features-sub" data-reveal>
            In Every Market
          </h3>
          <div className="shared-grid">
            {SHARED_FEATURES.map((f, i) => (
              <div className="shared" key={f.title} data-reveal style={{ "--i": i % 4 } as CSSProperties}>
                <span className="shared-icon" aria-hidden="true">
                  <f.icon />
                </span>
                <b>{f.title}</b>
                <span>{f.text}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="sees" id="privacy">
        <div className="shell sees-in">
          <div className="sees-art" aria-hidden="true" data-reveal>
            <span className="tilt" data-drift="-40">
              <Art name="shield" />
            </span>
          </div>
          <div className="sees-copy">
            <h2 className="display" data-reveal>
              What Each Party Can See
            </h2>
            <p className="lead" data-reveal>
              Three things work together so a bid stays private from everyone, this site included, for as long as it
              matters: shielded payments, bids locked in time, and a proof of the result.
            </p>
            <WhoSees />
          </div>
        </div>
      </section>

      <section className="protect">
        <div className="shell">
          <h2 className="display" data-reveal>
            Nine Protections, Built In
          </h2>
          <div className="protect-grid">
            {PROTECTIONS.map((p, i) => (
              <article className="slab" key={p.title} data-reveal data-tilt style={{ "--i": i % 3 } as CSSProperties}>
                <span className="slab-art" aria-hidden="true">
                  <Art name={p.art} />
                </span>
                <h3>{p.title}</h3>
                <p>{p.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="limits" id="limits">
        <div className="shell limits-in">
          <div className="limits-head">
            <span className="limits-art" aria-hidden="true" data-reveal>
              <span className="tilt" data-drift="30">
                <Art name="padlock" />
              </span>
            </span>
            <h2 className="display" data-reveal>
              What This Does Not Do
            </h2>
            <p className="lead" data-reveal>
              Said plainly, so you know exactly what you are trusting.
            </p>
          </div>
          <ul className="limits-list">
            {LIMITS.map((l, i) => (
              <li key={l.title} data-reveal style={{ "--i": i } as CSSProperties}>
                <b>{l.title}</b>
                <span>{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="shell act">
        <div data-reveal>
          <PracticePanel />
        </div>

        {/* The id sits on a plain wrapper: the part that fades in moves as it does, and a link must land on something that stays put. */}
        <section id="auctions">
          <div data-reveal>
            <div className="row spread" style={{ marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Auctions</h2>
              <Link href="/sell" className="small">
                List A Lot →
              </Link>
            </div>
            <AuctionsGrid />
          </div>
        </section>
      </div>

      <section className="close">
        <div className="shell close-in">
          <span className="close-art" aria-hidden="true" data-reveal>
            <span className="tilt" data-drift="-30">
              <Art name="safe" />
            </span>
          </span>
          <h2 className="display" data-reveal>
            The Vault Ends Empty.
          </h2>
          <p className="lead" data-reveal>
            When an auction is over, the price has gone to the seller and every other deposit has gone back to its
            bidder. The auction&apos;s vault holds nothing.
          </p>
          <div className="cta" data-reveal>
            <Link className="btn primary lg" href="/auctions">
              See the auctions
            </Link>
            <Link className="btn lg" href="/sell">
              Sell something
            </Link>
            <Link className="btn lg" href="/orders">
              See The Sales
            </Link>
            <Link className="btn lg" href="/settlement">
              Settle A Deal
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
