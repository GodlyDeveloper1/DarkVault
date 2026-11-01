// Pay Anywhere: pay a Dark Vault deposit with another coin, through NEAR Intents.
//
// Built for NEAR HACKATHON (November 2026). The browser asks the NEAR Intents
// 1Click API for a quote that delivers exactly the shielded ZEC a deposit needs
// to that deposit's one-time address. The payer sends the other coin (USDC,
// ETH, SOL, BTC, NEAR...) to the deposit address 1Click gives back; solvers
// swap it and deliver ZEC. Dark Vault's own signer sees an ordinary shielded
// payment arrive, and nothing else changes.
//
// The browser talks to 1Click directly: this site never learns which coin,
// chain or wallet paid. 1Click does, and the payment is public on its own chain
// (said on the page). NEAR Intents has no testnet, so this only runs in the
// mainnet build (NEXT_PUBLIC_ZCASH_NETWORK=main).

export const ONECLICK = "https://1click.chaindefuser.com/v0";
/** ZEC on the Zcash chain, as NEAR Intents names it. */
export const ZEC_ASSET = "nep141:zec.omft.near";

export interface Token {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
}

/** The coins offered, in this order: [blockchain, symbol, label]. Their asset ids are read from 1Click. */
export const OFFERED: [string, string, string][] = [
  ["base", "USDC", "USDC on Base"],
  ["arb", "USDC", "USDC on Arbitrum"],
  ["sol", "USDC", "USDC on Solana"],
  ["eth", "USDC", "USDC on Ethereum"],
  ["near", "USDC", "USDC on NEAR"],
  ["base", "ETH", "ETH on Base"],
  ["arb", "ETH", "ETH on Arbitrum"],
  ["eth", "ETH", "ETH on Ethereum"],
  ["sol", "SOL", "SOL on Solana"],
  ["btc", "BTC", "BTC on Bitcoin"],
  ["near", "wNEAR", "NEAR on NEAR"],
];

export interface Offered extends Token {
  label: string;
}

let tokenCache: Promise<Offered[]> | null = null;

/** The offered coins that 1Click currently supports, with their asset ids. */
export function offeredTokens(): Promise<Offered[]> {
  tokenCache ??= fetch(`${ONECLICK}/tokens`, { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error(`NEAR Intents answered ${r.status}`);
      return r.json() as Promise<Token[]>;
    })
    .then((all) => {
      const out: Offered[] = [];
      for (const [chain, symbol, label] of OFFERED) {
        const t = all.find((x) => x.blockchain === chain && x.symbol === symbol && /^nep(141|245):/.test(x.assetId));
        if (t) out.push({ ...t, label });
      }
      if (!all.some((x) => x.assetId === ZEC_ASSET)) throw new Error("NEAR Intents doesn't list ZEC right now");
      return out;
    })
    .catch((e) => {
      tokenCache = null;
      throw e;
    });
  return tokenCache;
}

/** A light check of a refund address on the paying chain, here in the browser. 1Click checks it properly. */
export function refundProblem(chain: string, address: string): string | null {
  const a = address.trim();
  if (!a) return "Give an address on the paying chain, for a refund if the swap can't be done.";
  const ok =
    ["base", "arb", "eth"].includes(chain) ? /^0x[0-9a-fA-F]{40}$/.test(a)
    : chain === "sol" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)
    : chain === "btc" ? /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a)
    : chain === "near" ? /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a) && a.length >= 2 && a.length <= 64
    : true;
  return ok ? null : "That doesn't look like an address on the paying chain.";
}

export interface Quote {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  deadline: string;
  timeEstimate?: number;
}

/**
 * A quote that delivers exactly `zat` zatoshis of ZEC to `zecAddress`.
 * dry: true only prices it; dry: false also returns a deposit address that is
 * live until the deadline.
 */
export async function quoteZec(opts: { from: Offered; zat: number; zecAddress: string; refundTo: string; dry: boolean }): Promise<Quote> {
  const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const res = await fetch(`${ONECLICK}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dry: opts.dry,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset: opts.from.assetId,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ZEC_ASSET,
      amount: String(opts.zat),
      recipient: opts.zecAddress,
      recipientType: "DESTINATION_CHAIN",
      refundTo: opts.refundTo.trim(),
      refundType: "ORIGIN_CHAIN",
      deadline,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.message === "string" ? body.message : `NEAR Intents answered ${res.status}`);
  const q = body.quote ?? body;
  if (!q.amountIn) throw new Error("NEAR Intents gave no price");
  return {
    depositAddress: q.depositAddress ?? "",
    depositMemo: q.depositMemo,
    amountIn: String(q.amountIn),
    amountInFormatted: String(q.amountInFormatted ?? q.amountIn),
    amountOut: String(q.amountOut ?? opts.zat),
    deadline: String(q.deadline ?? deadline),
    timeEstimate: typeof q.timeEstimate === "number" ? q.timeEstimate : undefined,
  };
}

export type SwapStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "INCOMPLETE_DEPOSIT" | "REFUNDED" | "FAILED" | string;

/** Where a swap has got to. */
export async function swapStatus(depositAddress: string, memo?: string): Promise<SwapStatus> {
  const q = new URLSearchParams({ depositAddress });
  if (memo) q.set("depositMemo", memo);
  const res = await fetch(`${ONECLICK}/status?${q}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`NEAR Intents answered ${res.status}`);
  const body = await res.json();
  return String(body.status ?? "PENDING_DEPOSIT");
}

export const STATUS_TEXT: Record<string, string> = {
  PENDING_DEPOSIT: "Waiting for your payment to the address above.",
  KNOWN_DEPOSIT_TX: "Your payment has been seen. Waiting for it to confirm on its chain.",
  PROCESSING: "Swapping. Solvers are delivering shielded ZEC to this deposit's address.",
  SUCCESS: "Delivered. The shielded ZEC is on its way to this deposit's address; it counts once it is in a block.",
  INCOMPLETE_DEPOSIT: "Less arrived than the quote asked for. NEAR Intents refunds it to your refund address.",
  REFUNDED: "The swap couldn't be done in time. NEAR Intents sent your payment back to your refund address.",
  FAILED: "The swap failed. NEAR Intents refunds your payment to your refund address.",
};
