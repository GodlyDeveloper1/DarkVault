// The Vault Guide's face: a plain, stern machine. Drawn here as one small SVG in
// the site's own colours, so nothing is fetched for it. It does two things:
// its eyes sweep and blink while it waits, and its grille moves while an
// answer is being written out.
export default function GuideBot({ talking = false, size = 36 }: { talking?: boolean; size?: number }) {
  return (
    <svg className={talking ? "gbot talk" : "gbot"} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      {/* Aerial, with a lamp that is lit while it speaks. */}
      <rect x="30" y="4" width="4" height="8" fill="#a8a8a0" />
      <circle className="gbot-lamp" cx="32" cy="4" r="3.2" />
      {/* Side plates. */}
      <rect x="1" y="25" width="7" height="14" rx="2" fill="#a8a8a0" />
      <rect x="56" y="25" width="7" height="14" rx="2" fill="#a8a8a0" />
      {/* The head, with its lower edge: the same slab the buttons and cards are cut from. */}
      <path d="M16 14H48L58 24V46L50 56H14L6 46V24Z" fill="#6d6d67" />
      <path d="M16 10H48L58 20V42L50 52H14L6 42V20Z" fill="#f5f5f0" />
      {/* Visor. */}
      <rect x="11" y="19" width="42" height="15" rx="4" fill="#050505" />
      <g className="gbot-eyes">
        <path d="M17 23.5L27 26.5V30.5H17Z" fill="#c6ff3a" />
        <path d="M47 23.5L37 26.5V30.5H47Z" fill="#c6ff3a" />
      </g>
      {/* Grille. */}
      <g fill="#050505">
        <rect className="gbot-bar" x="21" y="40" width="4" height="7" rx="1" />
        <rect className="gbot-bar" x="27" y="40" width="4" height="7" rx="1" />
        <rect className="gbot-bar" x="33" y="40" width="4" height="7" rx="1" />
        <rect className="gbot-bar" x="39" y="40" width="4" height="7" rx="1" />
      </g>
    </svg>
  );
}
