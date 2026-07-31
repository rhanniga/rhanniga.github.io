// @ts-check
/**
 * Keep the input line above the on-screen keyboard.
 *
 * `100dvh` handles the mobile URL bar and is the right default, but it does *not*
 * account for the software keyboard: on iOS the visual viewport shrinks while the
 * layout viewport does not, so the terminal keeps its full height and the prompt --
 * the one thing the visitor is looking at -- ends up underneath the keyboard.
 *
 * `visualViewport` is the only API that reports this. The height it gives excludes the
 * keyboard, so pinning the terminal to it is what makes the prompt stay visible.
 *
 * Three details that are all load-bearing:
 *
 *   - **`offsetTop` matters as much as `height`.** iOS scrolls the layout viewport up
 *     to reveal the focused element, so the visual viewport's origin moves. Without
 *     translating by `offsetTop` the terminal is the right size in the wrong place.
 *   - **Re-pin the scroll afterwards.** Resizing the container changes what "scrolled
 *     to the bottom" means, and the visitor was at the bottom, watching the prompt.
 *   - **Only when the keyboard is actually up.** Applying this unconditionally would
 *     fight `100dvh` on every desktop resize for no benefit, so the override is
 *     removed entirely when the two viewports agree.
 */

/** Below this difference, the two viewports are the same and nothing is overridden. */
const KEYBOARD_THRESHOLD_PX = 60;

/**
 * @param {HTMLElement} root  The #terminal element.
 * @param {() => void} pinScroll  Re-pin the scroll position (scrollToBottom).
 * @returns {() => void} teardown
 */
export function fitToVisualViewport(root, pinScroll) {
  const vv = /** @type {any} */ (globalThis).visualViewport;
  // Every desktop browser has this, but a missing API must degrade to the CSS
  // behaviour rather than throwing -- 100dvh alone is a perfectly good fallback.
  if (vv === undefined || vv === null) return () => {};

  let frame = 0;

  const apply = () => {
    frame = 0;
    const covered = window.innerHeight - vv.height;

    if (covered < KEYBOARD_THRESHOLD_PX) {
      // No keyboard. Hand height back to the stylesheet instead of freezing a value
      // that a rotation or a URL-bar change would invalidate.
      root.style.removeProperty("height");
      root.style.removeProperty("transform");
      return;
    }

    root.style.height = `${vv.height}px`;
    // Counteract the layout-viewport scroll iOS performs to reveal the input.
    root.style.transform = vv.offsetTop === 0 ? "" : `translateY(${vv.offsetTop}px)`;
    pinScroll();
  };

  // Coalesced: iOS fires resize and scroll many times through the keyboard
  // animation, and doing layout on each one visibly stutters.
  const schedule = () => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(apply);
  };

  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  apply();

  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    root.style.removeProperty("height");
    root.style.removeProperty("transform");
  };
}
