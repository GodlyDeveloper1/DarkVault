// What an auction record holds. One JSON file per auction, on the server only.
//
// PRIVATE fields never leave the server except to the person they belong to:
// a bid's refund and deposit addresses, each deposit's amount, the vault id and
// the settlement transaction id. See lib/views.ts for what each party is shown.
import type { BeaconChain, DeliveryVerdict, Fault, Receipt, Standing } from "vault-core";

export type AuctionState =
  | "funding" // listed, but not open yet: waiting for the seller's bond to arrive
  | "open" // taking sealed bids
  | "revealing" // bidding closed; bidders are revealing their amounts
  | "settling" // outcome decided; waiting for deposits to confirm, then paying out
  | "delivering" // sold with delivery: losers refunded, the price held until the lot is handed over
  | "settled"; // paid out (or there was nothing to pay)

export interface Bid {
  id: string;
  placed_at: number;
  /**
   * The commitment to the amount. Public.
   * Scheme 2: a Pedersen commitment (vault-core fairness.ts). Before: SHA-256.
   */
  commitment: string;
  /**
   * Scheme 2. PRIVATE. The amount and blinding, encrypted in the bidder's
   * browser so that nobody, this server included, can open them before the
   * auction's time-lock round. Never published: after the close it would give
   * away the losing bids.
   */
  sealed?: string;
  /** Scheme 2. The time-locked bid was opened, or tried, and could not be used: it was not a bid, or did not match the commitment. */
  unopenable?: "not-a-bid" | "mismatch";
  /** Scheme 2. What the site signed when it accepted this bid. Shown to its bidder. */
  receipt?: Receipt;
  /**
   * PRIVATE. Practice auctions only: the practice wallet this bid belongs to.
   * Its refund goes back to the house purse and is credited to that wallet.
   */
  practice?: string;
  /** Practice auctions only: what the house purse sent to this bid's deposit address for that wallet. */
  practice_paid?: { at: number; sent: number; txid: string };
  /** Hash of the token the bidder shows to see this bid's status. */
  token_hash: string;
  /** PRIVATE. Where this bidder's money goes back to. */
  refund_address: string;
  /** PRIVATE. Made for this bid alone; a deposit here is this bid's deposit. */
  deposit_address: string;
  /** Public key made in the bidder's browser. If this bid wins, the lot key is sealed to it. */
  delivery_pub?: string;
  /**
   * The opened bid, after bidding has closed. `nonce` opens the commitment
   * (scheme 2: it is the blinding). `by` says whether the time lock opened it
   * or the bidder's browser did, from the ticket.
   */
  reveal?: { amount: number; nonce: string; at: number; by?: "beacon" | "bidder" };
}

export interface PaymentRecord {
  kind: "seller" | "winner-change" | "refund" | "escrow" | "escrow-refund";
  bid_id?: string;
  /** What the plan said, before the network fee. */
  owed: number;
  /** What was sent, after this payment's share of the fee. */
  paid: number;
}

export interface SettlementRecord {
  /** PRIVATE: shown only to the people it pays. */
  txid: string;
  fee: number;
  at: number;
  payments: PaymentRecord[];
  /** True for a later settlement that only returns deposits which arrived after the first. */
  late?: boolean;
}

export interface OutcomeRecord {
  sold: boolean;
  /** The seller's bond never arrived, so the auction never opened. */
  cancelled?: boolean;
  price?: number;
  winner_bid_id?: string;
  standing: Record<string, Standing>;
  /**
   * Order Flow. PRIVATE (the prices). The winning orders of a batch sale, each
   * with what it offered and so pays, in an order drawn when the sale is
   * decided that nobody outside can predict: the winner at place k gets unit k. (Not best first: a
   * buyer would then learn from their unit's number how many orders beat
   * theirs.) `price` above is the lowest of them, which is public, and
   * `winner_bid_id` is not set.
   */
  winners?: { bid_id: string; price: number }[];
  /** How many bids counted (revealed, funded, at or above the reserve). */
  counted: number;
  decided_at: number;
}

/** Why the held price went where it went. */
export type ResolutionReason =
  | "confirmed" // the winner said they have the lot
  | "no-complaint" // the winner said nothing within the time limit after the handover
  | "not-delivered" // the seller didn't hand over in time
  | "no-shipping-details" // the winner never said where to send it
  | "wrong-key" // digital dispute: what the seller delivered doesn't open the lot
  | "key-was-right" // digital dispute: it does
  | "as-described" // the winner said the lot is what was described
  | "operator" // a dispute decided by the operator
  | "operator-timeout" // the operator didn't decide in time: the price goes back, nobody at fault
  | "agreed" // the seller offered part of the price back and the winner accepted
  | "not-sold"; // nothing was sold: the seller's bond goes back

/**
 * Delivery and escrow. When a lot sells, the price is not paid to the seller:
 * it moves to this auction's escrow vault and waits there until the lot has
 * been handed over. The site passes sealed envelopes between seller and winner
 * and can't open them.
 */
export interface Delivery {
  /**
   * "digital": a text or file, encrypted at listing, unlocked by a key.
   * "physical": something posted to the winner.
   * "promise": something the seller will do for the winner (naming rights, an
   *   hour of their time). It runs like a physical lot: the winner sends sealed
   *   instructions where a postal address would go, and the seller marks it done.
   */
  kind: "digital" | "physical" | "promise";
  /** The seller's public key. The winner seals shipping details to it. */
  seller_pub: string;
  /** Digital lots: the hash of the lot key and the size of the encrypted lot (stored in <data>/lots/). */
  lot?: { key_hash: string; bytes: number };
  /** Seconds each side has for its part of the handover. */
  deliver_seconds: number;
  /** Seconds the winner has, after the handover, to confirm or complain. */
  dispute_seconds: number;
  /**
   * Bonds, in zatoshis. 0 means none.
   * The seller funds theirs at the escrow address before bidding opens (the
   * amount is public: it is what the seller stands to lose). Every bid carries
   * the buyer's on top of the bid. Whoever is at fault for a failed delivery,
   * or loses a dispute they opened, forfeits their bond to the other side.
   */
  seller_bond: number;
  buyer_bond: number;
  /** When the seller's bond was seen in a block, which opens the auction. */
  bond_funded_at?: number;
  /** PRIVATE. The signer account that holds the price until delivery. */
  escrow_vault_id: string;
  /** PRIVATE. */
  escrow_address: string;

  /** When the price went into escrow. */
  started_at?: number;
  /** Physical: the winner must send shipping details by this time. */
  address_by?: number;
  /** Physical: the winner's shipping details, sealed to the seller. */
  shipping?: { at: number; envelope: string };
  /** The seller must hand over by this time. */
  deliver_by?: number;
  /** Digital: the lot key, sealed to the winner. Physical: marked as shipped, with an optional sealed note. */
  handover?: { at: number; envelope?: string };
  /** The winner must confirm or complain by this time. */
  dispute_by?: number;
  /** Physical: the winner said the parcel hasn't arrived yet, once, which added another complaint window. */
  extended_at?: number;
  confirmed_at?: number;
  dispute?: {
    at: number;
    /** "wrong-key" is decided by the keys at once; the other two wait for the operator. */
    kind: "wrong-key" | "not-as-described" | "physical" | "promise";
    reason?: string;
    verdict?: DeliveryVerdict;
    /** PRIVATE. Digital "not as described": the lot key, handed over by the winner so the operator can open the lot. */
    lot_key?: string;
    /** PRIVATE. Private auctions: the key to the listing, handed over by the winner so the operator can read what was described. */
    listing_key?: string;
    /** The seller's answer to the complaint. */
    seller_reply?: { at: number; text: string };
    /** The seller offers this percentage of the price back (1 to 100). The winner may accept it; the seller may change it until then. */
    offer?: { at: number; percent: number };
    /** How many evidence photos each side has added (stored in <data>/evidence/, seen only by the operator, deleted after the payout). */
    evidence?: { winner: number; seller: number };
  };
  /** `winner_percent`: a split only, the share of the price that goes back to the winner. */
  resolution?: { decision: "release" | "refund" | "return-bond" | "split"; reason: ResolutionReason; fault: Fault; at: number; winner_percent?: number };
  /** PRIVATE txid. The second payout: everything in escrow, to the seller, the winner or both. */
  payout?: {
    txid: string;
    fee: number;
    at: number;
    owed: number;
    paid: number;
    to_seller: { owed: number; paid: number } | null;
    to_winner: { owed: number; paid: number } | null;
    /** Order Flow: set on a unit's record once this payout has been seen in a block. The sale is finished when every unit's has. */
    mined?: boolean;
  };
  /** PRIVATE txids. A seller's bond that arrived after the auction was over, sent back. */
  stray_returns?: { txid: string; at: number; paid: number }[];
}

/**
 * Scheme 2. The time lock on an auction's bids: a drand network and the first
 * of its rounds signed after bidding ends. Fixed when bidding opens.
 */
export interface TimeLock {
  chain: BeaconChain;
  round: number;
  /** The round's signature, once it exists and has been checked. It is public. */
  beacon?: { round: number; signature: string };
}

export interface Auction {
  id: string;
  created_at: number;
  title: string;
  description: string;
  /**
   * 2: Pedersen commitments, time-locked bids and a
   * published proof of the result. Absent on auctions listed before these
   * existed: SHA-256 commitments opened by the bidders, deposits that cover
   * the bid.
   */
  scheme?: 2;
  reserve: number;
  /**
   * Scheme 2, optional. A highest bid allowed: when set, every bid deposits this plus the bond.
   * Absent on auctions listed now: a bid deposits at least itself plus the bond, and there is no highest bid.
   */
  ceiling?: number;
  /** Scheme 2. Set when bidding opens. */
  timelock?: TimeLock;
  /**
   * A practice auction, listed by the site itself (lib/house/). The seller is
   * the site, and `bot_bids` are bids placed by its automated bidders with
   * real deposits from the house purse. The page says so plainly.
   */
  house?: { n: number; bot_bids: string[]; bot_max: number };
  /**
   * A private auction: not listed, and shown only to browsers that hold the
   * invite. `listing` is the title and description, encrypted in the seller's
   * browser (the site can't open it; `title` and `description` above are then
   * placeholders). `access_hash` is the hash of the token an invited browser
   * shows. The invite key itself never reaches the site.
   */
  private?: { listing: string; access_hash: string };
  /**
   * How many listing photos there are (<data>/photos/<id>.<n>.bin), at most
   * MAX_PHOTOS. Each is a JPEG redrawn in the seller's browser, or, for a
   * private auction or a deal, that JPEG encrypted with the listing's key.
   */
  photos?: number;
  /**
   * A private deal (the Settlement market), not an auction: two people who
   * agreed a price elsewhere settle it here. There is no bidding. The buyer
   * accepts by paying the price plus the bond; the first payment in full takes
   * the deal, which then runs through the same escrow and handover as a sold
   * lot. `reserve` equals the price, `ends_at` is when the offer runs out, and
   * a deal is always private (its terms are encrypted in the seller's browser).
   * `public_price`: the seller chose to show the price on the public ledger.
   */
  deal?: { price: number; public_price: boolean };
  /**
   * Order Flow: a batch sale. One seller offers `units` identical units; each
   * sealed order is for one unit; the highest orders win one each and each
   * pays what it offered. It is a scheme 2 record (commitments, time lock, a
   * published proof), public, and every unit is digital: `lots` holds, per
   * unit, the hash of that unit's lot key and the size of its encrypted lot
   * (<data>/lots/<id>.u<n>.bin).
   *
   * `delivery` on this record carries the time limits, the buyer's bond per
   * order and the seller's bond for the whole sale, and its escrow vault holds
   * only that bond. When the sale is decided, each winner gets a record of
   * their own (`unit_of`), with its own escrow vault, and the handover of each
   * unit runs there exactly as a sold lot's does.
   */
  batch?: {
    units: number;
    lots: { key_hash: string; bytes: number }[];
    /**
     * PRIVATE. Set as the sale is decided: made from the site's own key and
     * this sale's id. The ids of the sold units' records, and which winner
     * gets which unit, come from it, so nobody outside can work either out,
     * and deciding the same sale again gives the same answer.
     */
    unit_seed?: string;
    /**
     * PRIVATE txid. The seller's bond, shared out after the close: an equal
     * share into the escrow of each unit that sold, the rest back to the
     * seller. `txid` is null when the sale has no bonds.
     */
    bond_split?: { txid: string | null; fee: number; at: number; to_seller: { owed: number; paid: number } | null; shares: { owed: number; paid: number }[] };
  };
  /**
   * Order Flow. This record is one sold unit of a batch sale, made by the
   * site when the sale was decided. Nobody addresses it: it is reached only
   * through the sale's own routes, and it appears in no list. `funded` is what
   * the sale has sent to this unit's escrow: the winner's price and bond (from
   * the first payout) and the seller's bond for this unit (from the split).
   */
  unit_of?: { parent: string; index: number; funded: { price?: number; bond?: number } };
  /** Scheme 2. Set when the result and its proof have been saved (<data>/proofs/). */
  proof?: { at: number; bytes: number };
  ends_at: number;
  /** How long bidding runs once the auction opens. */
  duration_seconds?: number;
  reveal_seconds: number;
  seller: {
    /** PRIVATE. */
    payout_address: string;
    /** Hash of the seller's manage token (itself derived from the manage key, which the server never sees). */
    key_hash: string;
  };
  /** PRIVATE. The signer account that holds this auction's deposits. */
  vault_id: string;
  /** Absent on auctions listed before delivery existed: those pay the seller at the close. */
  delivery?: Delivery;
  state: AuctionState;
  bids: Bid[];
  /** When bidding closed, and the chain height up to which deposits count. */
  closed?: { at: number; height: number };
  reveal_ends_at?: number;
  outcome?: OutcomeRecord;
  settlements: SettlementRecord[];
  /** Per bid, the deposits already paid out or returned. */
  deposits_settled?: Record<string, number>;
  /** The last thing that went wrong while advancing this auction, for the operator. */
  last_error?: string;
}
