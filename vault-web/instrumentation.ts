// Runs once when the Next.js server starts: moves auctions forward on a timer,
// so they close, decide and settle even when nobody is looking at them.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { tick } = await import("./lib/engine");
  const every = Number(process.env.VAULT_TICK_SEC ?? 10) * 1000;
  setInterval(() => void tick().catch(() => {}), every).unref?.();
}
