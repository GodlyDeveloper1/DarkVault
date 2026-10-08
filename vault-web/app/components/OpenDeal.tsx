"use client";

// "Have a deal link?" A buyer who was sent a link somewhere awkward (a chat on
// another device, say) can paste it here. The key in it stays after the #, so
// it is never sent to the site.
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function OpenDeal() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [wrong, setWrong] = useState(false);

  function go(e: React.FormEvent) {
    e.preventDefault();
    const m = /\/deal\/([0-9a-f]{32})#(invite|manage)=([0-9a-f]{64})(?![0-9a-f])/.exec(text.trim());
    if (!m) return setWrong(true);
    router.push(`/deal/${m[1]}#${m[2]}=${m[3]}`);
  }

  return (
    <form className="card" id="open-deal-form" onSubmit={go}>
      <h2>Have A Deal Link?</h2>
      <p className="muted small">Paste the link the seller sent you. It opens the deal: the terms, the price and where to pay.</p>
      <input
        id="deal-link"
        className="mono"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setWrong(false);
        }}
        placeholder="https://…/deal/…#invite=…"
        spellCheck={false}
        autoComplete="off"
        aria-label="Deal link"
      />
      {wrong && (
        <p className="hint error" id="deal-link-wrong">
          That is not a deal link. It looks like …/deal/…#invite=…
        </p>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={text.trim() === ""}>
          Open The Deal
        </button>
      </div>
    </form>
  );
}
