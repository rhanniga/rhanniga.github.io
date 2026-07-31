// @ts-check
/**
 * The two mobile affordances.
 *
 * Both are unverifiable by inspection on a desktop and both fail silently when wrong,
 * which is the worst combination: the soft keys are the only way to reach Ctrl+C on a
 * phone, and the viewport fit is the only thing keeping the prompt above the keyboard.
 * So the logic is tested here against fakes, and the remaining risk -- what iOS Safari
 * actually reports -- is explicitly a real-device check.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { mountSoftkeys } from "../site/js/terminal/softkeys.js";
import { fitToVisualViewport } from "../site/js/terminal/viewport-fit.js";

/* ── Fakes ──────────────────────────────────────────────────────────────── */

class FakeEl {
  constructor(tag = "div") {
    this.tag = tag;
    /** @type {FakeEl[]} */
    this.children = [];
    /** @type {Record<string, string>} */
    this.attrs = {};
    /** @type {Record<string, Array<(ev: any) => void>>} */
    this.listeners = {};
    this.textContent = "";
    this.type = "";
    this.tabIndex = 0;
    this.hidden = true;
    /** @type {Record<string, string>} */
    this.styles = {};
    // The code under test both assigns (`style.height = x`) and calls
    // (`style.removeProperty`), so a proxy covers each without listing properties.
    this.style = new Proxy(/** @type {any} */ ({}), {
      get: (_t, prop) => {
        if (prop === "removeProperty") return (k) => delete this.styles[k];
        if (prop === "setProperty") return (k, v) => (this.styles[k] = v);
        return this.styles[String(prop)];
      },
      set: (_t, prop, value) => {
        this.styles[String(prop)] = String(value);
        return true;
      },
    });
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  /** Fire a listener as the browser would. */
  fire(type, ev = {}) {
    let prevented = false;
    const event = { preventDefault: () => (prevented = true), ...ev };
    for (const fn of this.listeners[type] ?? []) fn(event);
    return prevented;
  }
}

function installDom() {
  const previous = /** @type {any} */ (globalThis).document;
  /** @type {any} */ (globalThis).document = {
    createElement: (tag) => new FakeEl(tag.toLowerCase()),
  };
  return () => {
    if (previous === undefined) delete /** @type {any} */ (globalThis).document;
    else /** @type {any} */ (globalThis).document = previous;
  };
}

/** A terminal API recording the key actions it was sent. */
function fakeTerm() {
  /** @type {string[]} */
  const sent = [];
  return { sent, api: /** @type {any} */ ({ sendKey: (a) => sent.push(a) }) };
}

/* ── Soft keys ──────────────────────────────────────────────────────────── */

test("the toolbar provides the keys a phone keyboard lacks", () => {
  // Tab, arrows and Ctrl are all absent from iOS and Android keyboards, so each of
  // these is the *only* route to that function on a phone.
  const restore = installDom();
  try {
    const host = new FakeEl();
    const term = fakeTerm();
    assert.equal(mountSoftkeys(host, term.api, () => {}), true);

    const actions = host.children.map((_, i) => {
      host.children[i].fire("pointerdown");
      return term.sent[term.sent.length - 1];
    });
    for (const required of ["tab", "up", "down", "interrupt", "clear"]) {
      assert.ok(actions.includes(required), `no soft key sends "${required}"`);
    }
  } finally {
    restore();
  }
});

test("every button is a real button with a label", () => {
  const restore = installDom();
  try {
    const host = new FakeEl();
    mountSoftkeys(host, fakeTerm().api, () => {});
    for (const button of host.children) {
      assert.equal(button.tag, "button");
      // Default type is submit; a stray form ancestor would make each key a reload.
      assert.equal(button.type, "button");
      assert.ok(button.textContent.length > 0, "button with no visible label");
      const aria = button.getAttribute("aria-label");
      assert.ok(aria !== null && aria.length > 5, `weak aria-label: ${aria}`);
      // "^C" alone is meaningless read aloud; the label must be words.
      assert.ok(/[a-z]{3}/.test(String(aria)), `aria-label is not prose: ${aria}`);
    }
  } finally {
    restore();
  }
});

test("the buttons are outside the tab order", () => {
  // Tab is a terminal key. Five focusable buttons would make Tab-completion
  // impossible with a hardware keyboard.
  const restore = installDom();
  try {
    const host = new FakeEl();
    mountSoftkeys(host, fakeTerm().api, () => {});
    for (const button of host.children) assert.equal(button.tabIndex, -1);
  } finally {
    restore();
  }
});

test("a tap prevents default and restores focus", () => {
  // On iOS, tapping a button blurs the textarea, which dismisses the keyboard and
  // shifts the layout under the visitor's finger mid-tap.
  const restore = installDom();
  try {
    const host = new FakeEl();
    let focused = 0;
    mountSoftkeys(host, fakeTerm().api, () => focused++);
    const prevented = host.children[0].fire("pointerdown");
    assert.equal(prevented, true, "pointerdown must be prevented");
    assert.equal(focused, 1, "focus must be restored after a tap");
  } finally {
    restore();
  }
});

test("the toolbar is revealed once mounted", () => {
  // Hidden in the markup so it never flashes before wiring; CSS still decides
  // whether a coarse pointer actually sees it.
  const restore = installDom();
  try {
    const host = new FakeEl();
    assert.equal(host.hidden, true);
    mountSoftkeys(host, fakeTerm().api, () => {});
    assert.equal(host.hidden, false);
  } finally {
    restore();
  }
});

test("a missing host is not an error", () => {
  assert.equal(mountSoftkeys(null, fakeTerm().api, () => {}), false);
});

/* ── Viewport fit ───────────────────────────────────────────────────────── */

/**
 * Install a fake visualViewport plus the rAF the module coalesces with.
 * @param {{height: number, offsetTop?: number, innerHeight: number}} initial
 */
function installViewport(initial) {
  const saved = {
    vv: /** @type {any} */ (globalThis).visualViewport,
    win: /** @type {any} */ (globalThis).window,
    raf: /** @type {any} */ (globalThis).requestAnimationFrame,
    caf: /** @type {any} */ (globalThis).cancelAnimationFrame,
  };

  /** @type {Record<string, Array<() => void>>} */
  const listeners = {};
  const vv = {
    height: initial.height,
    offsetTop: initial.offsetTop ?? 0,
    addEventListener: (t, fn) => void (listeners[t] ??= []).push(fn),
    removeEventListener: (t, fn) => {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    },
    fire: (t) => {
      for (const fn of listeners[t] ?? []) fn();
    },
    listenerCount: () => Object.values(listeners).reduce((n, a) => n + a.length, 0),
  };

  /** @type {Array<() => void>} */
  let pending = [];
  /** @type {any} */ (globalThis).visualViewport = vv;
  /** @type {any} */ (globalThis).window = { innerHeight: initial.innerHeight };
  /** @type {any} */ (globalThis).requestAnimationFrame = (fn) => {
    pending.push(fn);
    return pending.length;
  };
  /** @type {any} */ (globalThis).cancelAnimationFrame = () => {
    pending = [];
  };

  return {
    vv,
    /** Run whatever rAF callbacks are queued. */
    flush: () => {
      const run = pending;
      pending = [];
      for (const fn of run) fn();
    },
    restore: () => {
      /** @type {any} */ (globalThis).visualViewport = saved.vv;
      /** @type {any} */ (globalThis).window = saved.win;
      /** @type {any} */ (globalThis).requestAnimationFrame = saved.raf;
      /** @type {any} */ (globalThis).cancelAnimationFrame = saved.caf;
    },
  };
}

test("with no keyboard the height is left to CSS", () => {
  // Freezing a pixel height here would break on rotation and on every URL-bar
  // change, both of which 100dvh already handles correctly.
  const env = installViewport({ height: 800, innerHeight: 800 });
  try {
    const root = new FakeEl();
    fitToVisualViewport(/** @type {any} */ (root), () => {});
    assert.equal(root.styles.height, undefined, `height was set to ${root.styles.height}`);
  } finally {
    env.restore();
  }
});

test("when the keyboard opens the terminal shrinks to the visible height", () => {
  const env = installViewport({ height: 800, innerHeight: 800 });
  try {
    const root = new FakeEl();
    let pinned = 0;
    fitToVisualViewport(/** @type {any} */ (root), () => pinned++);

    // The keyboard covers ~340px, as an iPhone's does.
    env.vv.height = 460;
    env.vv.fire("resize");
    env.flush();

    assert.equal(root.styles.height, "460px");
    assert.ok(pinned > 0, "scroll must be re-pinned after resizing");
  } finally {
    env.restore();
  }
});

test("the layout-viewport scroll offset is compensated", () => {
  // iOS scrolls the layout viewport up to reveal the focused input, so the visual
  // viewport's origin moves. Without this the terminal is the right size in the
  // wrong place, and the prompt is still off-screen.
  const env = installViewport({ height: 800, innerHeight: 800 });
  try {
    const root = new FakeEl();
    fitToVisualViewport(/** @type {any} */ (root), () => {});
    env.vv.height = 460;
    env.vv.offsetTop = 120;
    env.vv.fire("scroll");
    env.flush();
    assert.equal(root.styles.transform, "translateY(120px)");
  } finally {
    env.restore();
  }
});

test("closing the keyboard hands height back to CSS", () => {
  const env = installViewport({ height: 800, innerHeight: 800 });
  try {
    const root = new FakeEl();
    fitToVisualViewport(/** @type {any} */ (root), () => {});
    env.vv.height = 460;
    env.vv.fire("resize");
    env.flush();
    assert.equal(root.styles.height, "460px");

    env.vv.height = 800;
    env.vv.fire("resize");
    env.flush();
    assert.equal(root.styles.height, undefined, "the override must be removed, not frozen");
    assert.equal(root.styles.transform, undefined);
  } finally {
    env.restore();
  }
});

test("a small difference is ignored", () => {
  // Browser chrome and rounding produce a few pixels of difference constantly. A
  // threshold keeps this from fighting 100dvh on every desktop resize.
  const env = installViewport({ height: 800, innerHeight: 800 });
  try {
    const root = new FakeEl();
    fitToVisualViewport(/** @type {any} */ (root), () => {});
    env.vv.height = 770;
    env.vv.fire("resize");
    env.flush();
    assert.equal(root.styles.height, undefined);
  } finally {
    env.restore();
  }
});

test("bursts of resize events collapse into one layout", () => {
  // iOS fires resize and scroll many times through the keyboard animation, and doing
  // layout on each visibly stutters.
  const env = installViewport({ height: 800, innerHeight: 800 });
  try {
    const root = new FakeEl();
    let pinned = 0;
    fitToVisualViewport(/** @type {any} */ (root), () => pinned++);
    env.vv.height = 460;
    for (let i = 0; i < 10; i++) env.vv.fire("resize");
    env.flush();
    assert.equal(pinned, 1, `${pinned} layouts for one gesture`);
  } finally {
    env.restore();
  }
});

test("teardown removes every listener and style", () => {
  const env = installViewport({ height: 800, innerHeight: 800 });
  try {
    const root = new FakeEl();
    const stop = fitToVisualViewport(/** @type {any} */ (root), () => {});
    env.vv.height = 460;
    env.vv.fire("resize");
    env.flush();
    assert.ok(env.vv.listenerCount() > 0);

    stop();
    assert.equal(env.vv.listenerCount(), 0);
    assert.equal(root.styles.height, undefined);
  } finally {
    env.restore();
  }
});

test("a browser without visualViewport degrades quietly", () => {
  // The CSS fallback is 100dvh, which is fine on its own. Throwing here would take
  // the whole terminal down on an old browser.
  const saved = /** @type {any} */ (globalThis).visualViewport;
  delete /** @type {any} */ (globalThis).visualViewport;
  try {
    const root = new FakeEl();
    let stop;
    assert.doesNotThrow(() => {
      stop = fitToVisualViewport(/** @type {any} */ (root), () => {});
    });
    assert.doesNotThrow(() => /** @type {any} */ (stop)());
  } finally {
    if (saved !== undefined) /** @type {any} */ (globalThis).visualViewport = saved;
  }
});
