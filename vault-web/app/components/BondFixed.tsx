// The seller's bond, shown, not asked for: it is fixed at 10% of the price,
// never under the site's minimum, the same for the seller and every buyer.
import { formatCoins, MIN_BOND } from "vault-core";
import { COIN } from "@/lib/network";

export default function BondFixed({ amount, of, each, units }: { amount: number; of: string; each?: number; units?: number }) {
  return (
    <div className="bond-fixed" id="bond">
      <span className="bond-amount mono">{amount > 0 ? `${formatCoins(amount)} ${COIN}` : "Enter a price first"}</span>
      <span className="bond-rule">
        {each !== undefined && units !== undefined && amount > 0 ? `${formatCoins(each)} ${COIN} × ${units} units. ` : ""}
        Fixed: 10% of {of}, never under {formatCoins(MIN_BOND)} {COIN}.
      </span>
    </div>
  );
}
