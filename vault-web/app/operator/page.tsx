import type { Metadata } from "next";
import OperatorDesk from "./OperatorDesk";

// The operator's desk: every open dispute, in every market, and the buttons
// that decide them. Linked from nowhere. Without the operator key it shows a
// key box and nothing else: every request behind it answers "not found".
export const metadata: Metadata = { title: "Private", robots: { index: false, follow: false } };

export default function OperatorPage() {
  return (
    <main>
      <div className="shell">
        <OperatorDesk />
      </div>
    </main>
  );
}
