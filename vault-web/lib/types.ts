// What an auction record holds. One JSON file per auction, on the server only.
//
// PRIVATE fields never leave the server except to the person they belong to:
// a bid's refund and deposit addresses, each deposit's amount, the vault id and
// the settlement transaction id. See lib/views.ts for what each party is shown.
import type { DeliveryVerdict, Fault, Standing } from "vault-core";

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
  /** SHA-256 commitment to the amount. Public. */
  commitment: string;
  /** Hash of the token the bidder shows to see this bid's status. */
  token_hash: string;
  /** PRIVATE. Where this bidder's money goes back to. */
  refund_address: string;
  /** PRIVATE. Made for this bid alone; a deposit here is this bid's deposit. */
  deposit_address: string;
  /** Public key made in the bidder's browser. If this bid wins, the lot key is sealed to it. */
  delivery_pub?: string;
  /** Set once the bidder opens the commitment, after bidding has closed. */
  reveal?: { amount: number; nonce: string; at: number };
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
  confirmed_at?: number;
  dispute?: {
    at: number;
    /** "wrong-key" is decided by the keys at once; the other two wait for the operator. */
    kind: "wrong-key" | "not-as-described" | "physical" | "promise";
    reason?: string;
    verdict?: DeliveryVerdict;
    /** PRIVATE. Digital "not as described": the lot key, handed over by the winner so the operator can open the lot. */
    lot_key?: string;
    /** The seller's answer to the complaint. */
    seller_reply?: { at: number; text: string };
  };
  resolution?: { decision: "release" | "refund" | "return-bond"; reason: ResolutionReason; fault: Fault; at: number };
  /** PRIVATE txid. The second payout: everything in escrow, to the seller, the winner or both. */
  payout?: { txid: string; fee: number; at: number; owed: number; paid: number; to_seller: { owed: number; paid: number } | null; to_winner: { owed: number; paid: number } | null };
  /** PRIVATE txids. A seller's bond that arrived after the auction was over, sent back. */
  stray_returns?: { txid: string; at: number; paid: number }[];
}

export interface Auction {
  id: string;
  created_at: number;
  title: string;
  description: string;
  reserve: number;
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
