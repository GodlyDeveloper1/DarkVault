// Shown while a page is being put together. It sits inside the frame, so the
// header or the sidebar stays where it is.
export default function Loading() {
  return (
    <main className="loader" aria-busy="true" aria-live="polite">
      <div className="loader-in">
        <span className="loader-art" aria-hidden="true">
          <span className="ring" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/art/s/safe.webp" alt="" width={192} height={192} draggable={false} />
        </span>
        <p className="loader-title">Opening The Vault</p>
        <p className="loader-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </p>
        <p className="peak sm">Privacy At Its Peak.</p>
      </div>
    </main>
  );
}
