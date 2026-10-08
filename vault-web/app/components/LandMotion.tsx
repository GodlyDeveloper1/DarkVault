"use client";

// Motion for the home page. It renders nothing: it finds the page's sections
// by their data attributes and moves them as the visitor scrolls and points.
//
//   - the hero's objects follow the pointer by depth and fly apart as it scrolls away
//   - the scroll stories, one for each market: a pinned stage whose objects
//     move between that story's steps. Scrolling chooses the step; each change
//     then plays in its own time
//   - everything marked data-reveal fades in when it enters the screen and out when it leaves
//   - cards marked data-tilt lean towards the pointer
//
//   - the page itself scrolls smoothly: the wheel is eased by Lenis, a small
//     library bundled with the app, so one notch glides instead of jumping
//
// No network. With reduced motion switched on, none of this runs and the page
// is a plain document that scrolls the ordinary way (see ".dv-motion" in
// globals.css).
import Lenis from "lenis";
import "lenis/dist/lenis.css";
import { useEffect, useLayoutEffect } from "react";

/** One object in one step: x and y in percent of the scene from its centre, scale, rotation in degrees, opacity. */
type Pose = [x: number, y: number, s: number, r: number, o: number];

const OFF_LOW: Pose = [0, 70, 0.5, 0, 0];

const OFF_HIGH: Pose = [0, -70, 0.5, 0, 0];
const OFF_LEFT: Pose = [-70, 10, 0.4, -16, 0];
const OFF_RIGHT: Pose = [70, 10, 0.4, 16, 0];

// Where every object is in each of the six steps: list, bid, deposit, unlock, settle, deliver.
const AUCTION: Record<string, Pose[]> = {
  safe: [
    [0, 2, 1.55, 0, 1],
    [30, -30, 0.55, 6, 1],
    [0, -16, 1.1, 0, 1],
    [32, -32, 0.5, 6, 1],
    [-34, -30, 0.5, -6, 1],
    [-32, -30, 0.55, -6, 1],
  ],
  key: [
    [32, 30, 0.62, -18, 1],
    [64, 44, 0.4, -50, 0],
    [64, 44, 0.4, -50, 0],
    [64, 44, 0.4, -50, 0],
    [64, 44, 0.4, -50, 0],
    [64, 44, 0.4, -50, 0],
  ],
  "money-bag": [
    [-31, -27, 0.58, -8, 1],
    [-64, -44, 0.4, -24, 0],
    [-64, -44, 0.4, -24, 0],
    [-64, -44, 0.4, -24, 0],
    [64, -44, 0.4, 20, 0],
    [31, -24, 0.62, 8, 1],
  ],
  envelope: [
    OFF_LOW,
    [0, 4, 1.45, -4, 1],
    [-32, -32, 0.5, -10, 1],
    [-27, 24, 0.78, -8, 1],
    [-60, 44, 0.45, -16, 0],
    [-60, 44, 0.45, -16, 0],
  ],
  padlock: [
    [40, 70, 0.4, 0, 0],
    [24, 23, 0.62, 10, 1],
    [-23, -23, 0.3, 10, 1],
    [-8, 56, 0.5, 85, 0],
    [-8, 56, 0.5, 85, 0],
    [-8, 56, 0.5, 85, 0],
  ],
  clock: [
    [-64, -50, 0.4, 0, 0],
    [-31, -29, 0.56, -10, 1],
    [34, -34, 0.42, 10, 1],
    [7, -7, 1.4, 0, 1],
    [64, -50, 0.4, 10, 0],
    [64, -50, 0.4, 10, 0],
  ],
  // Three coins, one for each bidder. They go into the vault, and come back out at settlement.
  coin9: [
    [-30, 74, 0.4, 0, 0],
    [-30, 74, 0.4, 0, 0],
    [-31, 29, 0.52, -8, 1],
    [32, -32, 0.2, 0, 0],
    [-37, 31, 0.46, -10, 1],
    [-4, 6, 0.2, 0, 0],
  ],
  coin10: [
    OFF_LOW,
    OFF_LOW,
    [0, 35, 0.52, 0, 1],
    [32, -32, 0.2, 0, 0],
    [0, 40, 0.46, 0, 1],
    [0, 72, 0.4, 0, 0],
  ],
  coin11: [
    [30, 74, 0.4, 0, 0],
    [30, 74, 0.4, 0, 0],
    [31, 29, 0.52, 8, 1],
    [32, -32, 0.2, 0, 0],
    [37, 31, 0.46, 10, 1],
    [60, 60, 0.4, 20, 0],
  ],
  trophy: [OFF_LOW, OFF_LOW, OFF_LOW, [0, 60, 0.6, 0, 0], [0, -6, 1.35, 0, 1], [62, 44, 0.4, 14, 0]],
  medal: [
    [64, -44, 0.4, 10, 0],
    [64, -44, 0.4, 10, 0],
    [64, -44, 0.4, 10, 0],
    [64, -44, 0.4, 10, 0],
    [34, -27, 0.56, 10, 1],
    [64, -44, 0.4, 10, 0],
  ],
  tick: [
    [40, 70, 0.3, 0, 0],
    [40, 70, 0.3, 0, 0],
    [40, 70, 0.3, 0, 0],
    [40, 70, 0.3, 0, 0],
    [37, 4, 0.3, 0, 1],
    [31, 27, 0.46, 0, 1],
  ],
  wallet: [OFF_LOW, OFF_LOW, OFF_LOW, OFF_LOW, [0, 70, 0.6, 0, 0], [-2, 7, 1.4, -4, 1]],
};

// Order Flow, in five steps: list the units, seal the orders, the clock opens them, the highest win, each unit is handed over.
// Three keys are the units, three envelopes the orders, three coins what each buyer offered (three sizes: three prices).
const ORDERS: Record<string, Pose[]> = {
  keyA: [
    [-27, 6, 0.86, -26, 1],
    [-37, -34, 0.34, -26, 1],
    [-37, -34, 0.34, -26, 1],
    [-37, -34, 0.34, -26, 1],
    [-28, 2, 0.74, -26, 1],
  ],
  keyB: [
    [0, -4, 1.02, -8, 1],
    [-27, -37, 0.34, -8, 1],
    [-27, -37, 0.34, -8, 1],
    [-27, -37, 0.34, -8, 1],
    [0, -6, 0.86, -8, 1],
  ],
  keyC: [
    [27, 6, 0.86, 14, 1],
    [-17, -34, 0.34, 14, 1],
    [-17, -34, 0.34, 14, 1],
    [-17, -34, 0.34, 14, 1],
    [28, 2, 0.74, 14, 1],
  ],
  safe: [
    [31, -31, 0.52, 6, 1],
    [32, -32, 0.5, 6, 1],
    [32, -32, 0.5, 6, 1],
    [34, -33, 0.44, 6, 1],
    [-34, -33, 0.42, -6, 1],
  ],
  bag: [
    [-31, 31, 0.5, -8, 1],
    [-62, 44, 0.4, -20, 0],
    [-62, 44, 0.4, -20, 0],
    [-62, 44, 0.4, -20, 0],
    [-62, 44, 0.4, -20, 0],
  ],
  envA: [OFF_LEFT, [-29, 8, 0.74, -10, 1], [-30, 29, 0.56, -12, 1], [-60, 46, 0.4, -18, 0], [-60, 46, 0.4, -18, 0]],
  envB: [OFF_LOW, [0, 0, 0.96, -2, 1], [0, 35, 0.56, 0, 1], [0, 72, 0.4, 0, 0], [0, 72, 0.4, 0, 0]],
  envC: [OFF_RIGHT, [29, 8, 0.74, 10, 1], [30, 29, 0.56, 12, 1], [60, 46, 0.4, 18, 0], [60, 46, 0.4, 18, 0]],
  padlock: [
    [40, 70, 0.4, 0, 0],
    [15, 15, 0.36, 10, 1],
    [-6, 58, 0.4, 85, 0],
    [-6, 58, 0.4, 85, 0],
    [-6, 58, 0.4, 85, 0],
  ],
  clock: [OFF_HIGH, [2, -36, 0.4, 0, 1], [0, -8, 1.3, 0, 1], [64, -50, 0.4, 10, 0], [64, -50, 0.4, 10, 0]],
  // What each buyer offered. Different sizes: each winner pays their own number.
  coinA: [OFF_LOW, [-29, 37, 0.3, -8, 1], [32, -32, 0.2, 0, 0], [-29, 36, 0.3, -8, 1], [-8, 30, 0.2, 0, 0]],
  coinB: [OFF_LOW, [0, 36, 0.3, 0, 1], [32, -32, 0.2, 0, 0], [0, 33, 0.44, 0, 1], [0, 30, 0.2, 0, 0]],
  coinC: [OFF_LOW, [29, 37, 0.3, 8, 1], [32, -32, 0.2, 0, 0], [29, 36, 0.36, 8, 1], [8, 30, 0.2, 0, 0]],
  medalA: [OFF_LEFT, OFF_LEFT, OFF_LEFT, [-29, 3, 0.76, -8, 1], [-62, -40, 0.3, -8, 0]],
  medalB: [OFF_HIGH, OFF_HIGH, OFF_HIGH, [0, -5, 1, 0, 1], [0, -74, 0.3, 0, 0]],
  medalC: [OFF_RIGHT, OFF_RIGHT, OFF_RIGHT, [29, 3, 0.76, 8, 1], [62, -40, 0.3, 8, 0]],
  tick: [
    [40, 70, 0.3, 0, 0],
    [40, 70, 0.3, 0, 0],
    [40, 70, 0.3, 0, 0],
    [6, -40, 0.28, 0, 1],
    [33, 30, 0.44, 0, 1],
  ],
  wallet: [OFF_LOW, OFF_LOW, OFF_LOW, [0, 72, 0.6, 0, 0], [-2, 33, 0.66, -4, 1]],
};

// Settlement, in five steps: agree, seal the terms, pay into escrow, hand over and release, public only by choice.
// Two wallets are the two people, the envelope the terms, the two bags the two bonds.
const SETTLEMENT: Record<string, Pose[]> = {
  walletA: [
    [-27, 2, 0.92, -8, 1],
    [-15, 39, 0.34, -8, 1],
    [-64, 46, 0.4, -16, 0],
    [-2, 6, 1.3, -4, 1],
    [-64, 46, 0.4, -16, 0],
  ],
  walletB: [
    [27, 2, 0.92, 8, 1],
    [12, 40, 0.34, 8, 1],
    [64, 46, 0.4, 16, 0],
    [64, 46, 0.4, 16, 0],
    [64, 46, 0.4, 16, 0],
  ],
  coin: [
    [0, -6, 0.5, 0, 1],
    [12, 40, 0.2, 0, 0],
    [0, 37, 0.5, 0, 1],
    [-4, 6, 0.2, 0, 0],
    [31, 27, 0.56, 8, 1],
  ],
  envelope: [OFF_LOW, [0, 2, 1.36, -4, 1], [-33, -33, 0.44, -10, 1], [-62, -46, 0.4, -16, 0], [-62, -46, 0.4, -16, 0]],
  padlock: [
    [40, 70, 0.4, 0, 0],
    [28, 22, 0.58, 10, 1],
    [-24, -27, 0.24, 10, 1],
    [-62, -40, 0.3, 10, 0],
    [-62, -40, 0.3, 10, 0],
  ],
  key: [OFF_LEFT, [-29, -27, 0.56, -18, 1], [-64, -44, 0.4, -40, 0], [-31, 28, 0.56, -18, 1], [-64, 44, 0.4, -40, 0]],
  safe: [OFF_HIGH, [0, -72, 0.6, 0, 0], [0, -6, 1.3, 0, 1], [-33, -31, 0.5, -6, 1], [-64, -46, 0.4, -10, 0]],
  // The two bonds: one from each side.
  bagA: [OFF_LEFT, OFF_LEFT, [-33, 26, 0.5, -8, 1], [-64, 30, 0.4, -16, 0], [-64, 30, 0.4, -16, 0]],
  bagB: [OFF_RIGHT, OFF_RIGHT, [33, 26, 0.5, 8, 1], [64, 30, 0.4, 16, 0], [64, 30, 0.4, 16, 0]],
  tick: [
    [40, -70, 0.3, 0, 0],
    [40, -70, 0.3, 0, 0],
    [40, -70, 0.3, 0, 0],
    [32, -25, 0.5, 0, 1],
    [64, -44, 0.3, 0, 0],
  ],
  shield: [OFF_LOW, OFF_LOW, OFF_LOW, [0, 74, 0.6, 0, 0], [-3, -3, 1.36, 0, 1]],
};

/** The poses of each story on the page, by the name in its data-story. */
const STORIES: Record<string, Record<string, Pose[]>> = { auction: AUCTION, orders: ORDERS, settlement: SETTLEMENT };

/** One scroll story on the page, and where its stage has got to. */
interface Story {
  el: HTMLElement;
  scene: HTMLElement | null;
  texts: HTMLElement[];
  actors: HTMLElement[];
  poses: Record<string, Pose[]>;
  steps: number;
  /** The step the scroll has reached, and where the stage is now. */
  due: number;
  shown: number;
  lastStep: number;
  /** What was last drawn, so a stage that is standing still is left alone. */
  drawn: string;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// useLayoutEffect warns when a component is rendered on the server.
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function LandMotion() {
  useBeforePaint(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = document.documentElement;
    root.classList.add("dv-motion");

    const hero = document.querySelector<HTMLElement>("[data-hero]");
    const stories: Story[] = [...document.querySelectorAll<HTMLElement>("[data-story]")].map((el) => {
      const texts = [...el.querySelectorAll<HTMLElement>("[data-step-text]")];
      return {
        el,
        scene: el.querySelector<HTMLElement>("[data-scene]"),
        texts,
        actors: [...el.querySelectorAll<HTMLElement>("[data-actor]")],
        poses: STORIES[el.dataset.story || "auction"] ?? {},
        steps: texts.length,
        due: 0,
        shown: 0,
        lastStep: -1,
        drawn: "",
      };
    });
    const drifters = [...document.querySelectorAll<HTMLElement>("[data-drift]")];
    const undo: (() => void)[] = [];

    // --- the page scrolls smoothly ----------------------------------------------
    // Lenis eases the mouse wheel: each notch moves the page a little less far and
    // glides to a stop. It moves the real scroll position, so the pinned stage,
    // the scroll bar, the keyboard and links to a place on the page all work as
    // usual. Touch screens keep their own scrolling. A panel that scrolls by
    // itself (the wallet) is marked data-lenis-prevent and is left alone.
    const lenis = new Lenis({ lerp: 0.08, wheelMultiplier: 0.9, autoRaf: true });
    undo.push(() => lenis.destroy());

    // --- links to a place on this page ------------------------------------------
    // The router only moves the page when the address changes, so a second click
    // on the same link did nothing. Those clicks are handled here: the page
    // glides to the place, and is set straight once more when it gets there, in
    // case something above it changed height on the way.
    let lastTouch = 0; // when the visitor last scrolled by hand
    const touched = () => {
      lastTouch = performance.now();
    };
    for (const kind of ["wheel", "touchstart", "keydown"] as const) window.addEventListener(kind, touched, { passive: true });
    undo.push(() => {
      for (const kind of ["wheel", "touchstart", "keydown"] as const) window.removeEventListener(kind, touched);
    });

    /** Where the page has to be for this element to sit just below the header. */
    const placeOf = (el: HTMLElement) =>
      Math.max(0, Math.round(window.scrollY + el.getBoundingClientRect().top - (parseFloat(getComputedStyle(el).scrollMarginTop) || 0)));

    function glideTo(el: HTMLElement) {
      const started = performance.now();
      lenis.scrollTo(placeOf(el), {
        duration: 1.4,
        onComplete: () => {
          // Still off, and the visitor has not taken over: finish the job.
          if (lastTouch < started && Math.abs(placeOf(el) - window.scrollY) > 4) lenis.scrollTo(placeOf(el), { duration: 0.5 });
        },
      });
    }

    function follow(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as HTMLElement).closest?.<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank") return;
      const to = new URL(link.href, location.href);
      if (to.origin !== location.origin || to.pathname !== location.pathname || !to.hash) return;
      const el = document.getElementById(decodeURIComponent(to.hash.slice(1)));
      if (!el) return;
      e.preventDefault(); // the router leaves a click alone once this is set
      if (location.hash !== to.hash) history.replaceState(null, "", to.hash);
      glideTo(el);
    }
    window.addEventListener("click", follow, true);
    undo.push(() => window.removeEventListener("click", follow, true));

    // Arriving from another page with a place in the address: the router has
    // already jumped there. Set it straight once the page has finished loading.
    const arrivedAt = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    if (arrivedAt) {
      const started = performance.now();
      const settle = () => {
        if (lastTouch < started && Math.abs(placeOf(arrivedAt) - window.scrollY) > 4) lenis.scrollTo(placeOf(arrivedAt), { immediate: true });
      };
      const timers = [window.setTimeout(settle, 350), window.setTimeout(settle, 1300)];
      undo.push(() => timers.forEach((t) => window.clearTimeout(t)));
    }

    // --- fade in on the way in, fade out on the way out ---------------------
    const seen = new IntersectionObserver(
      (entries) => {
        for (const e of entries) e.target.classList.toggle("is-in", e.isIntersecting);
      },
      { rootMargin: "-9% 0px -9% 0px", threshold: 0.01 },
    );
    document.querySelectorAll("[data-reveal]").forEach((el) => seen.observe(el));
    undo.push(() => seen.disconnect());

    // --- the scroll story -----------------------------------------------------
    const headerHeight = () => document.querySelector<HTMLElement>("header.top")?.offsetHeight ?? 0;

    /** How far through a story the page is: 0 at the first step, steps - 1 at the last. */
    function storyAt(st: Story): number {
      const r = st.el.getBoundingClientRect();
      const travel = r.height - (window.innerHeight - headerHeight());
      return travel <= 0 ? 0 : clamp((headerHeight() - r.top) / travel) * (st.steps - 1);
    }

    // A story is not tied to the scroll bar inch by inch. Scrolling chooses
    // which step is due; each change of step then plays out in its own time,
    // start to finish, however fast the page was scrolled. `shown` is where
    // the stage is now, `due` the step the scroll has reached.
    const STEP_SECONDS = 1.05;
    function drawStory(st: Story) {
      const { scene } = st;
      if (!scene || st.steps < 2) return;
      // Standing still, at the size it was last drawn at: nothing to do.
      const stamp = `${st.shown}:${scene.clientWidth}:${scene.clientHeight}`;
      if (stamp === st.drawn) return;
      st.drawn = stamp;
      const i = Math.min(st.steps - 2, Math.max(0, Math.floor(st.shown)));
      const t = smooth(clamp(st.shown - i));
      const w = scene.clientWidth / 100;
      const h = scene.clientHeight / 100;

      for (const el of st.actors) {
        const poses = st.poses[el.dataset.actor ?? ""];
        if (!poses) continue;
        const a = poses[i]!;
        const b = poses[i + 1]!;
        const o = mix(a[4], b[4], t);
        el.style.opacity = o.toFixed(3);
        el.style.visibility = o < 0.01 ? "hidden" : "visible";
        el.style.transform =
          `translate(-50%, -50%) translate3d(${(mix(a[0], b[0], t) * w).toFixed(1)}px, ${(mix(a[1], b[1], t) * h).toFixed(1)}px, 0) ` +
          `rotate(${mix(a[3], b[3], t).toFixed(2)}deg) scale(${mix(a[2], b[2], t).toFixed(3)})`;
      }

      // The words: the step that is leaving fades out and up as the next fades in from below.
      // At rest a step has no transform and no filter at all, so its type is drawn sharp.
      st.texts.forEach((el, n) => {
        const out = n === i ? clamp(t / 0.6) : n === i + 1 ? 1 - clamp((t - 0.4) / 0.6) : 1;
        const o = 1 - out;
        el.style.opacity = o.toFixed(3);
        el.style.visibility = o < 0.01 ? "hidden" : "visible";
        el.style.transform = out > 0.004 ? `translateY(${Math.round((n === i ? -1 : 1) * out * 34)}px)` : "none";
        el.style.filter = out > 0.02 ? `blur(${(out * 8).toFixed(1)}px)` : "none";
      });

      const step = Math.round(st.shown);
      if (step !== st.lastStep) {
        st.lastStep = step;
        st.el.dataset.step = String(step);
      }
    }

    // The rail under the words jumps to a step of its own story.
    for (const st of stories) {
      const jump = (e: Event) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-step-go]");
        if (!btn || st.steps < 2) return;
        const n = Number(btn.dataset.stepGo);
        const r = st.el.getBoundingClientRect();
        const travel = r.height - (window.innerHeight - headerHeight());
        lenis.scrollTo(window.scrollY + r.top - headerHeight() + (travel * n) / (st.steps - 1), { duration: 1.4 });
      };
      st.el.addEventListener("click", jump);
      undo.push(() => st.el.removeEventListener("click", jump));
    }

    // --- the hero and the drifting objects -------------------------------------
    // These follow the scroll, but glide after it instead of jumping with every notch of the wheel.
    let heroDue = 0;
    let heroShown = 0;
    const driftDue = drifters.map(() => 0);
    const driftShown = drifters.map(() => 0);

    /** Reads where the scroll has got to. Nothing is drawn here. */
    function measure() {
      if (hero) {
        const r = hero.getBoundingClientRect();
        heroDue = clamp(-r.top / (r.height * 0.85));
      }
      const vh = window.innerHeight;
      drifters.forEach((el, n) => {
        const r = el.getBoundingClientRect();
        // -1 when the object is a screen below the middle, +1 a screen above it. (Its own drift is taken out again.)
        const middle = r.top + r.height / 2 - driftShown[n]! * Number(el.dataset.drift);
        driftDue[n] = clamp((vh / 2 - middle) / vh, -1, 1);
      });
      for (const st of stories) st.due = Math.round(storyAt(st));
    }

    function draw() {
      hero?.style.setProperty("--hp", heroShown.toFixed(4));
      drifters.forEach((el, n) => {
        el.style.setProperty("--drift", `${(driftShown[n]! * Number(el.dataset.drift)).toFixed(1)}px`);
        el.style.setProperty("--turn", `${(driftShown[n]! * 14).toFixed(2)}deg`);
      });
      stories.forEach(drawStory);
    }

    /** Moves everything a little closer to where it is due. Returns false once it has all arrived. */
    function advance(dt: number): boolean {
      let moving = false;
      for (const st of stories) {
        const gap = st.due - st.shown;
        if (Math.abs(gap) > 0.0005) {
          // One step takes STEP_SECONDS. Several steps behind (a fast scroll), it hurries, but still plays each one.
          const pace = Math.max(1, Math.abs(gap)) / STEP_SECONDS;
          st.shown += Math.sign(gap) * Math.min(Math.abs(gap), pace * dt);
          moving = true;
        } else st.shown = st.due;
      }

      const ease = 1 - Math.exp(-dt * 6);
      if (Math.abs(heroDue - heroShown) > 0.0005) {
        heroShown += (heroDue - heroShown) * ease;
        moving = true;
      } else heroShown = heroDue;
      driftDue.forEach((d, n) => {
        if (Math.abs(d - driftShown[n]!) > 0.0005) {
          driftShown[n]! += (d - driftShown[n]!) * ease;
          moving = true;
        } else driftShown[n] = d;
      });
      return moving;
    }

    // The pointer, eased so the objects glide after it.
    let px = 0;
    let py = 0;
    let tx = 0;
    let ty = 0;
    let gliding = 0;
    function glide() {
      px += (tx - px) * 0.08;
      py += (ty - py) * 0.08;
      root.style.setProperty("--px", px.toFixed(4));
      root.style.setProperty("--py", py.toFixed(4));
      gliding = Math.abs(tx - px) + Math.abs(ty - py) > 0.002 ? requestAnimationFrame(glide) : 0;
    }
    function point(e: PointerEvent) {
      if (e.pointerType === "touch") return;
      tx = (e.clientX / window.innerWidth) * 2 - 1;
      ty = (e.clientY / window.innerHeight) * 2 - 1;
      if (!gliding) gliding = requestAnimationFrame(glide);
    }
    window.addEventListener("pointermove", point, { passive: true });
    undo.push(() => window.removeEventListener("pointermove", point));

    // --- cards that lean towards the pointer -----------------------------------
    function lean(e: PointerEvent) {
      if (e.pointerType === "touch") return;
      const card = (e.target as HTMLElement).closest<HTMLElement>("[data-tilt]");
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--ry", `${(((e.clientX - r.left) / r.width - 0.5) * 12).toFixed(2)}deg`);
      card.style.setProperty("--rx", `${((0.5 - (e.clientY - r.top) / r.height) * 10).toFixed(2)}deg`);
    }
    function straighten(e: PointerEvent) {
      const card = (e.target as HTMLElement).closest?.<HTMLElement>("[data-tilt]");
      if (card && !card.contains(e.relatedTarget as Node | null)) {
        card.style.setProperty("--rx", "0deg");
        card.style.setProperty("--ry", "0deg");
      }
    }
    document.addEventListener("pointermove", lean, { passive: true });
    document.addEventListener("pointerout", straighten, { passive: true });
    undo.push(() => {
      document.removeEventListener("pointermove", lean);
      document.removeEventListener("pointerout", straighten);
    });

    // --- the loop: runs while anything is still on its way, then stops ----------
    let frame = 0;
    let before = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, before ? (now - before) / 1000 : 0.016);
      before = now;
      measure();
      const moving = advance(dt);
      draw();
      frame = moving ? requestAnimationFrame(tick) : 0;
      if (!moving) before = 0;
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    window.addEventListener("scroll", queue, { passive: true });
    window.addEventListener("resize", queue, { passive: true });
    // The first drawing is where the page already is: nothing plays on arrival.
    measure();
    for (const st of stories) st.shown = st.due;
    heroShown = heroDue;
    driftDue.forEach((d, n) => (driftShown[n] = d));
    draw();

    return () => {
      window.removeEventListener("scroll", queue);
      window.removeEventListener("resize", queue);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(gliding);
      undo.forEach((u) => u());
      root.classList.remove("dv-motion");
      root.style.removeProperty("--px");
      root.style.removeProperty("--py");
    };
  }, []);

  return null;
}
