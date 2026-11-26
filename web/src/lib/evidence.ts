/**
 * Evidence chain → screen. Elements that display a number carry `data-fact` with one or more
 * fact-id prefixes (e.g. "person.alice" or "flow.ttfr"). A chip for "person.alice.reviews_given"
 * resolves to the most specific element whose prefix matches, scrolls it into view and flashes it.
 */

export { contributorKey, factSegment } from "../../../src/narrative/fact-id.ts";

type Revealer = (factId: string) => boolean;
const revealers = new Set<Revealer>();

/** Lets collapsed UI (e.g. a non-selected tab) bring a fact into the DOM before we look for it. */
export function registerRevealer(fn: Revealer): () => void {
  revealers.add(fn);
  return () => revealers.delete(fn);
}

export function factAttr(...ids: string[]): { "data-fact": string } {
  return { "data-fact": ids.join(" ") };
}

function findTarget(factId: string): HTMLElement | null {
  const parts = factId.split(".");
  for (let len = parts.length; len >= 1; len--) {
    const prefix = parts.slice(0, len).join(".");
    const el = document.querySelector<HTMLElement>(`[data-fact~="${CSS.escape(prefix)}"]`);
    if (el) return el;
  }
  return null;
}

export function focusFact(factId: string): boolean {
  let changed = false;
  for (const reveal of revealers) changed = reveal(factId) || changed;
  const run = () => {
    const el = findTarget(factId);
    if (!el) return false;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    el.classList.remove("fact-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("fact-flash");
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
    window.setTimeout(() => el.classList.remove("fact-flash"), 1900);
    return true;
  };
  if (changed) {
    requestAnimationFrame(() => requestAnimationFrame(run));
    return true;
  }
  return run();
}
