const BEFORE_SWAP_EVENT = 'astro:before-swap';

/**
 * Runs page-scoped cleanup once, either when Astro swaps the current document
 * or when the returned function is called directly.
 */
export function onPageLeave(
  target: EventTarget,
  cleanup: () => void,
): () => void {
  let active = true;

  const run = (): void => {
    if (!active) return;
    active = false;
    target.removeEventListener(BEFORE_SWAP_EVENT, run);
    cleanup();
  };

  target.addEventListener(BEFORE_SWAP_EVENT, run, { once: true });
  return run;
}
