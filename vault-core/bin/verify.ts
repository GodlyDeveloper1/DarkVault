// Check an auction's result from the command line, without the web page.
//
//   cd vault-core
//   npm run verify -- http://127.0.0.1:3100 AUCTION-ID
//
// It fetches the public result and its proof from the site and checks them
// with the same code the page runs: the winning commitment holds the price,
// every other bid that counted is proven lower, and the time lock's signature
// is real. Nothing secret is needed, so anyone can run it.
//
// A private auction's result is for its invited bidders: give the invite link
// in place of the site and id, in quotes.
//
//   npm run verify -- "http://127.0.0.1:3100/auction/AUCTION-ID#invite=KEY"
import { inviteAccess, inviteFromText, formatCoins, isPublicBeacon, roundAfter, roundTimeMs, trustedChain, verifyBeacon, verifyFairness, type BeaconChain, type FairnessProof, type FairnessStatement } from "../src/index.ts";

let [site, id, inviteArg] = process.argv.slice(2);
// One argument that is a whole auction link: take the site, the id and the invite from it.
const link = /^(https?:\/\/[^/]+)\/auction\/([0-9a-f]{32})/.exec(site ?? "");
if (link && id === undefined) {
  inviteArg = site;
  [, site, id] = link;
}
if (!site || !/^[0-9a-f]{32}$/.test(id ?? "")) {
  console.error("Usage: npm run verify -- SITE AUCTION-ID   (for example: npm run verify -- http://127.0.0.1:3100 0123…cdef)");
  console.error('       npm run verify -- "INVITE-LINK"     (a private auction: the whole link, in quotes)');
  process.exit(2);
}
const invite = inviteArg ? inviteFromText(inviteArg) : null;
// A private auction lets in whoever shows the token made from its invite. The invite itself is not sent.
const headers: Record<string, string> = invite ? { "x-invite": await inviteAccess(invite) } : {};

const base = site.replace(/\/+$/, "");
const res = await fetch(`${base}/api/auctions/${id}/proof`, { headers });
if (!res.ok) {
  console.error(`The site has no result for this auction yet (it answered ${res.status}). A result is published when the auction is decided.`);
  if (!invite) console.error("If the auction is private, give its invite link instead of the site and id.");
  process.exit(2);
}
const { statement, proof, timelock } = (await res.json()) as {
  statement: FairnessStatement;
  proof: FairnessProof;
  timelock: { chain: BeaconChain; round: number; beacon?: { round: number; signature: string } } | null;
};

let failed = false;
const say = (ok: boolean | null, text: string) => {
  if (ok === false) failed = true;
  console.log(`${ok === null ? " - " : ok ? " ok " : "FAIL"}  ${text}`);
};

say(statement.auction_id === id, `The result is for auction ${id}.`);
// An auction without a ceiling states the price (or, unsold, the reserve) as the bound of its proof.
const capped = statement.ceiling !== (statement.sold ? statement.price : statement.reserve);
console.log(`      ${statement.bids.length} bids on the board, reserve ${formatCoins(statement.reserve)} TAZ${capped ? `, highest bid allowed ${formatCoins(statement.ceiling)} TAZ` : ""}.`);

const verdict = await verifyFairness(statement, proof);
if (verdict.ok) {
  if (statement.sold) {
    say(true, `Bid #${statement.winner! + 1} opens to exactly ${formatCoins(statement.price!)} TAZ.`);
    say(true, `${verdict.counted - 1} other bid(s) that counted are each proven to be lower, without their amounts.`);
  } else say(true, `Not sold: ${verdict.counted} bid(s) counted, each proven to be below the reserve.`);
} else for (const p of verdict.problems) say(false, `The proof fails: ${p}.`);

const skipped = statement.bids.map((b, i) => ({ ...b, n: i + 1 })).filter((b) => b.status !== "counted");
if (skipped.length) say(null, `Not counted, and not covered by the proof: ${skipped.map((b) => `#${b.n} (${b.status})`).join(", ")}. Only each bidder can check their own.`);

// The time lock: the round must come after bidding ended. For the public
// network, its key and clock are constants in vault-core, not the site's word.
const page = await fetch(`${base}/api/auctions/${id}`, { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const endsAt: number | undefined = page?.auction?.ends_at;
if (!timelock) say(false, "The result does not say what the bids were locked to.");
else {
  const chain = trustedChain(timelock.chain);
  const real = isPublicBeacon(timelock.chain);
  const name = real ? "the public drand network" : "a TEST beacon, which locks nothing";
  if (endsAt === undefined) say(null, "Could not read the auction's end time from the site, so the round was not compared with it.");
  else if (timelock.round < roundAfter(chain, endsAt)) say(false, `Bids were locked to a round signed at ${new Date(roundTimeMs(chain, timelock.round)).toISOString()}, before bidding ended (${new Date(endsAt).toISOString()}).`);
  else say(real ? true : null, `Bids were locked to round ${timelock.round} of ${name}, signed after bidding ended.`);
  if (!timelock.beacon) say(null, "The site did not fetch the round's signature; bidders opened their own bids.");
  else say(timelock.beacon.round === timelock.round && verifyBeacon(chain, timelock.beacon), "The signature that opened the bids is that round's.");
  const board: string[] | undefined = page?.auction?.commitments;
  if (board) say(board.length === statement.bids.length && board.every((c, i) => c === statement.bids[i]!.commitment), "The board in the result is the board the site shows.");
}

console.log(failed ? "\nThe result does NOT check out." : "\nThe result checks out.");
process.exit(failed ? 1 : 0);
