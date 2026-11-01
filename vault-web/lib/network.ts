// Which Zcash network this build of Dark Vault runs on. Set at build time with
// NEXT_PUBLIC_ZCASH_NETWORK=main for the mainnet deployment (Pay Anywhere, built
// for NEAR HACKATHON); anything else means testnet, as before.
export const MAINNET = process.env.NEXT_PUBLIC_ZCASH_NETWORK === "main";
/** The coin's name on this network: ZEC on mainnet, TAZ on testnet. */
export const COIN = MAINNET ? "ZEC" : "TAZ";
/** How a unified address starts on this network. */
export const UA_PREFIX = MAINNET ? "u1" : "utest1";
/** The network's name, for sentences. */
export const NETWORK_NAME = MAINNET ? "Zcash mainnet" : "Zcash testnet";
/** "testnet" or "Zcash", for "a fresh address from your … wallet". */
export const WALLET_WORD = MAINNET ? "Zcash" : "testnet";
