// Runs once when the Next.js server starts: moves auctions forward on a timer,
// so they close, decide and settle even when nobody is looking at them.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { tick } = await import("./lib/engine");
  // The house: practice auctions and their purse. Does nothing unless HOUSE_SIGNER_URL is set.
  const { houseTick } = await import("./lib/house/auctions");
  const every = Number(process.env.VAULT_TICK_SEC ?? 10) * 1000;
  setInterval(
    () =>
      void tick()
        .catch(() => {})
        .then(() => houseTick())
        .catch(() => {}),
    every,
  ).unref?.();
}
