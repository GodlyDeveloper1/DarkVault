// What an auction record holds. One JSON file per auction, on the server only.
//
// PRIVATE fields never leave the server except to the person they belong to:
// a bid's refund and deposit addresses, each deposit's amount, the vault id and
// the settlement transaction id. See lib/views.ts for what each party is shown.
import type { DeliveryVerdict, Standing } from "vault-core";

export type AuctionState =
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
  | "operator"; // physical dispute, decided by the operator

/**
 * Delivery and escrow. When a lot sells, the price is not paid to the seller:
 * it moves to this auction's escrow vault and waits there until the lot has
 * been handed over. The site passes sealed envelopes between seller and winner
 * and can't open them.
 */
export interface Delivery {
  kind: "digital" | "physical";
  /** The seller's public key. The winner seals shipping details to it. */
  seller_pub: string;
  /** Digital lots: the hash of the lot key and the size of the encrypted lot (stored in <data>/lots/). */
  lot?: { key_hash: string; bytes: number };
  /** Seconds each side has for its part of the handover. */
  deliver_seconds: number;
  /** Seconds the winner has, after the handover, to confirm or complain. */
  dispute_seconds: number;
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
  dispute?: { at: number; reason?: string; verdict?: DeliveryVerdict };
  resolution?: { decision: "release" | "refund"; reason: ResolutionReason; at: number };
  /** PRIVATE txid. The second payout: the held price to the seller, or back to the winner. */
  payout?: { txid: string; fee: number; at: number; owed: number; paid: number };
}

export interface Auction {
  id: string;
  created_at: number;
  title: string;
  description: string;
  reserve: number;
  ends_at: number;
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
